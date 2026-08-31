import { lazy, Suspense, useMemo } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { AgentsSkeleton } from "@/features/agents/AgentsSkeleton";
import { useNavigate } from "@tanstack/react-router";
import {
  useHomeCatalog,
  useHomeInsightsStatus,
  useHomeInstallations,
  useHomeRemoteGateways,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import type { WorkspaceSummary } from "../core/types";
import type { AgentFilter } from "@/components/AppSidebar";
import type { AgentKind } from "@/core/types";

const AgentsPageLazy = lazy(() =>
  import("@/features/agents/AgentsPage").then(({ AgentsPage }) => ({ default: AgentsPage })),
);

function AgentsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { agent?: AgentKind; agentFilter?: AgentFilter };
  const { data: installations = [], isPending: installationsPending } = useHomeInstallations();
  const { data: catalog = [], isPending: catalogPending } = useHomeCatalog();
  const assets = useMemo(() => catalog.filter((asset) => asset.scope === "agent-home"), [catalog]);
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: remoteGateways = [], isPending: gatewaysPending } = useHomeRemoteGateways();
  const { data: insightsStatus, isPending: insightsPending } = useHomeInsightsStatus();
  const openWorkspace = async (workspace: WorkspaceSummary) => {
    await navigate({ to: "/workspace/$workspaceId", params: { workspaceId: workspace.id } });
  };

  if (
    workspacesPending ||
    installationsPending ||
    catalogPending ||
    gatewaysPending ||
    insightsPending
  )
    return <AgentsSkeleton />;

  return (
    <Suspense fallback={<AgentsSkeleton />}>
      <AgentsPageLazy
        installations={installations}
        assets={assets}
        workspaces={workspaces}
        remoteGateways={remoteGateways}
        insightsStatus={insightsStatus}
        onOpen={openWorkspace}
        filter={search.agentFilter ?? "all"}
        selectedAgent={search.agent}
        onSelectedAgentChange={(agent) =>
          void navigate({
            to: "/agents",
            search: (current) => ({ ...current, agent }) as never,
          })
        }
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/agents")({ component: AgentsRoute });
