/** @jsxImportSource octane */

import type { AgentKind } from "@/core/types";

export const sessionHandoffTargets: Array<[AgentKind, string]> = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["cursor", "Cursor"],
  ["open-claw", "OpenClaw"],
  ["hermes", "Hermes"],
  ["deepseek-harness", "DeepSeek Harness"],
];
