import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceDoctorSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspaceDoctorPage } from "@/features/workspace/WorkspaceDoctorPage";
import { api } from "@/core/api";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import type { ContextDoctorSummary } from "@/core/types";

function WorkspaceDoctorRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/doctor" });
  const search = useSearch({ strict: false }) as { doctorVerification?: "applied" };
  const [verification] = useState(search.doctorVerification);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const {
    project,
    selectedWorkspace,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setAppliedChanges,
  } = useWorkspaceStore();
  const repairRequest = useRef(0);
  const diagnosisSignature = useRef("");
  useEffect(
    () => () => {
      repairRequest.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!search.doctorVerification) return;
    void navigate({
      to: "/workspace/$workspaceId/doctor",
      params: { workspaceId },
      replace: true,
      search: (current) => {
        const { doctorVerification: _verification, ...next } = current as {
          doctorVerification?: "applied";
        };
        return next as never;
      },
    });
  }, [navigate, search.doctorVerification, workspaceId]);
  const recordDiagnosis = useCallback(
    async (summary: ContextDoctorSummary) => {
      const signature = `${summary.workspace_id}:${summary.error_count}:${summary.warning_count}:${summary.repairable_count}`;
      if (diagnosisSignature.current === signature) return;
      const onboarding = useAppStore.getState().runtime?.onboarding;
      if (onboarding && onboarding.acknowledged_version >= onboarding.version) {
        diagnosisSignature.current = signature;
        return;
      }
      const runtime = await api.updateOnboarding({
        event: "doctor-completed",
        workspace_id: summary.workspace_id,
        repairable_count: summary.repairable_count,
      });
      diagnosisSignature.current = signature;
      setRuntime(runtime);
    },
    [setRuntime],
  );
  if (!selectedWorkspace) return <WorkspaceDoctorSkeleton />;
  const planRepairs = async () => {
    if (!project) return;
    const requestId = ++repairRequest.current;
    const targetProject = project;
    setAppliedChanges(undefined);
    const currentManifest = await api.manifest(targetProject);
    if (requestId !== repairRequest.current) return;
    const nextChangeSet = await api.plan(targetProject, currentManifest, false);
    if (requestId !== repairRequest.current) return;
    if (useWorkspaceStore.getState().selectedWorkspace?.id !== workspaceId) return;
    setChangeSet(nextChangeSet, currentManifest);
    setChangeSetOrigin("doctor");
    setHandoffLaunchRequest(undefined);
    void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
  };
  return (
    <WorkspaceDoctorPage
      workspace={selectedWorkspace}
      onRepair={planRepairs}
      verification={verification}
      onDiagnosed={recordDiagnosis}
      onOpenIssue={(destination) => {
        if (destination === "context") {
          void navigate({ to: "/workspace/$workspaceId/context", params: { workspaceId } });
          return;
        }
        void navigate({
          to: "/workspace/$workspaceId/assets",
          params: { workspaceId },
          search: { workspaceAssetSection: destination } as never,
        });
      }}
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/doctor")({
  staticData: { appRoute: { kind: "workspace", page: "doctor" } },
  component: WorkspaceDoctorRoute,
});
