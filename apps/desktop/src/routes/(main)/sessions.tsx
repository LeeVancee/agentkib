import { createFileRoute } from "@tanstack/react-router";
import { SessionHubPage } from "@/features/sessions/SessionHubPage";

export const Route = createFileRoute("/(main)/sessions")({
  staticData: { appRoute: { kind: "global", page: "sessions" } },
  component: SessionHubPage,
});
