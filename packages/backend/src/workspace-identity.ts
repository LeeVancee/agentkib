import { canonicalProject } from "./files";
import { lexicalPathIdentity } from "./paths";
import type { BackendStore } from "./store";

type WorkspaceStore = Pick<BackendStore, "sql">;
export interface WorkspaceIdentity {
  registeredId: string;
  project: string;
  archiveWorkspaceId: string;
}

/** Registered IDs take precedence over legacy manifest aliases. */
export function resolveWorkspaceIdentity(store: WorkspaceStore, id: string): WorkspaceIdentity {
  const rows = store.sql.rows(
    `SELECT id, canonical_path, manifest_workspace_id FROM workspaces
     WHERE id = ? OR manifest_workspace_id = ?
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 2`,
    id,
    id,
    id,
  );
  const workspace = rows[0];
  if (!workspace) throw new Error("Workspace does not exist");
  if (workspace.id !== id && rows.length > 1)
    throw new Error("Ambiguous workspace alias; reconnect using its registered ID");
  const registeredProject = String(workspace.canonical_path);
  const project = canonicalProject(registeredProject);
  if (lexicalPathIdentity(project) !== lexicalPathIdentity(registeredProject))
    throw new Error("Registered workspace path changed; refresh the workspace before continuing");
  return {
    registeredId: String(workspace.id),
    project,
    archiveWorkspaceId:
      typeof workspace.manifest_workspace_id === "string" && workspace.manifest_workspace_id
        ? workspace.manifest_workspace_id
        : String(workspace.id),
  };
}

/** Old archives and import receipts have only a manifest namespace, not a physical owner. */
export function requireUniqueContinuationWorkspace(
  store: WorkspaceStore,
  id: string,
  expectedProject?: string,
): WorkspaceIdentity {
  const workspace = resolveWorkspaceIdentity(store, id);
  const owners = store.sql.rows(
    "SELECT id FROM workspaces WHERE id = ? OR manifest_workspace_id = ? LIMIT 2",
    workspace.archiveWorkspaceId,
    workspace.archiveWorkspaceId,
  );
  if (owners.length !== 1 || owners[0]!.id !== workspace.registeredId)
    throw new Error(
      "Continuation archive ownership is ambiguous between registered workspaces; shared manifest archives cannot be read or written",
    );
  if (
    expectedProject !== undefined &&
    lexicalPathIdentity(workspace.project) !== lexicalPathIdentity(expectedProject)
  )
    throw new Error("Continuation workspace path changed");
  return workspace;
}
