import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { WorkspaceGitSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspaceGitPage, type GitSubview } from "@/features/workspace/WorkspaceGitPage";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

type GitSearch = { gitSubview?: GitSubview };

function WorkspaceGitRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/git" });
  const search = useSearch({ strict: false }) as GitSearch;
  const { selectedWorkspace } = useWorkspaceStore();
  if (!selectedWorkspace) return <WorkspaceGitSkeleton />;
  return (
    <WorkspaceGitPage
      workspace={selectedWorkspace}
      subview={search.gitSubview}
      onSubviewChange={(gitSubview) =>
        void navigate({
          to: "/workspace/$workspaceId/git",
          params: { workspaceId },
          search: (current) => ({ ...current, gitSubview }) as never,
        })
      }
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/git")({
  staticData: { appRoute: { kind: "workspace", page: "git" } },
  component: WorkspaceGitRoute,
});
