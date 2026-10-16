import { useLayoutEffect, useRef } from "react";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

export function usePageMessageScope(scope: string) {
  const revision = useWorkspaceStore((state) => state.messageRevision);
  const previous = useRef({ scope, revision });
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { scope, revision };
    // Only retire the notice already seen on the previous page. A destination
    // may publish a new error, even with identical text, during navigation.
    if (old.scope !== scope) useWorkspaceStore.getState().dismissMessage(old.revision);
  }, [scope, revision]);
}
