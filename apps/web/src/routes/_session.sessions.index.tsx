import { useEffect } from "octane";
import { createFileRoute } from "@octanejs/tanstack-router";
import { SessionEmpty } from "@/features/sessions/session-empty";
import { useSession } from "@/features/sessions/session-context";
export const Route = createFileRoute("/_session/sessions/")({ component: Index });
function Index() {
  const { leaveSession } = useSession();
  useEffect(() => {
    leaveSession();
  }, [leaveSession]);
  return <SessionEmpty />;
}
