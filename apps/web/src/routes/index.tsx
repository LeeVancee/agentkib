import { HostedHome } from "@/features/connection/hosted-home";
import { createFileRoute, Navigate } from "@octanejs/tanstack-router";
import { useEnvironment } from "@/providers/environment";
export const Route = createFileRoute("/")({ component: Index });
function Index() {
  const env = useEnvironment();
  return env.hosted && !env.connection ? <HostedHome /> : <Navigate to="/sessions" replace />;
}
