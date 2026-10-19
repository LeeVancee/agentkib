import { SessionContinuationReadOnly } from "@agentkib/session-ui";
import { useCallback } from "react";
import { useSession } from "./session-context";

export function SessionReadOnly({ reason }: { reason?: string | null }) {
  const { selected, current, client, access, locale } = useSession();
  const currentId = current?.id;
  const agent = current?.agent;
  const accessStatus = access?.status;
  const deviceId = access?.device?.id;
  const loadCommand = useCallback(
    async (signal: AbortSignal) => {
      if (
        !selected ||
        currentId !== selected ||
        !["codex", "claude-code"].includes(agent ?? "") ||
        accessStatus !== "approved" ||
        !deviceId
      )
        throw new Error("session-unavailable");
      const result = await (agent === "claude-code"
        ? client.claudeResumeCommand(selected, signal)
        : client.codexResumeCommand(selected, signal));
      if (!result.available || !result.command.trim()) throw new Error("command-unavailable");
      return result.command;
    },
    [selected, currentId, agent, client, accessStatus, deviceId],
  );
  return (
    <div className="w-full max-w-3xl self-center">
      {/* The desktop app runs on the host, so the help does not name another computer. */}
      <SessionContinuationReadOnly
        locale={locale}
        reason={reason}
        loadCommand={loadCommand}
        local
      />
    </div>
  );
}
