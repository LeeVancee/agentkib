/** @jsxImportSource octane */

import { createFileRoute, useNavigate, useParams } from "@octanejs/tanstack-router";
import { useHomeInstallations } from "@/features/home/home-query.tsx";
import { WorkspaceSessionsSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspaceSessionsPage } from "@/features/workspace/WorkspaceSessionsPage";
import { api } from "../../../core/api";
import { useAppStore } from "../../../stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

function WorkspaceSessionsRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/sessions" });
  const { runtime, setRuntime } = useAppStore();
  const { data: installations = [] } = useHomeInstallations();
  const { selectedWorkspace, scan, setChangeSet, setChangeSetOrigin, setHandoffLaunchRequest } =
    useWorkspaceStore();
  if (!selectedWorkspace || !scan) return <WorkspaceSessionsSkeleton />;
  const targetAgents = Array.from(
    new Set([
      ...scan.agents.filter((agent: any) => agent.detected).map((agent: any) => agent.agent),
      ...installations.filter((agent: any) => agent.installed).map((agent: any) => agent.agent),
    ]),
  );
  return (
    <WorkspaceSessionsPage
      workspace={selectedWorkspace}
      enabled={runtime?.session_index_enabled !== false}
      targetAgents={targetAgents}
      onRuntimeChanged={async (enabled) => {
        setRuntime(await api.setSessionIndexEnabled(enabled));
      }}
      onHandoffPlanned={(planned) => {
        setChangeSet(planned.change_set);
        setHandoffLaunchRequest(planned.launch_request);
        setChangeSetOrigin("handoff");
        void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
      }}
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/sessions")({
  component: WorkspaceSessionsRoute,
});
