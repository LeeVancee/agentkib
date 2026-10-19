import { SessionContinuationChoice } from "@agentkib/session-ui";
import { useSession } from "./session-context";
import { useSessionNavigate } from "./session-navigation";
import { managedControlCopy } from "./managed-control-copy";

export function SessionBusyChoice({ onReturn }: { onReturn: () => void }) {
  const session = useSession();
  const navigate = useSessionNavigate();
  return (
    <div className="w-full max-w-3xl self-center space-y-2">
      <SessionContinuationChoice
        locale={session.locale}
        agent="Codex"
        title={session.currentTitle || session.current?.title || session.t.untitled}
        disabled={session.busy}
        forkDisabled={
          !session.online ||
          !session.controlReady ||
          !session.access?.device?.manage ||
          !session.capabilities?.features.fork?.available
        }
        onFork={async () => {
          const id = await session.forkContinuation();
          if (id) await navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
        }}
        onReturn={onReturn}
      />
      {!session.access?.device?.manage && (
        <p className="px-3 text-xs text-muted-foreground">
          {managedControlCopy[session.locale].management}
        </p>
      )}
    </div>
  );
}
