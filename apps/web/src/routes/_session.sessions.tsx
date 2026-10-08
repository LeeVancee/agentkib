import { createFileRoute } from "@octanejs/tanstack-router";
import { SessionWorkspace } from "@/features/sessions/session-workspace";
export const Route = createFileRoute("/_session/sessions")({ component: SessionWorkspace });
