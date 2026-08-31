export type StorageMeasurement = "allocated-exact" | "logical-estimate";
export type StorageQuality = "complete" | "partial" | "unavailable";
export type StorageNodeKind = "workspace" | "directory" | "root-files" | "aggregate";
export interface StorageNode {
  id: string;
  name: string;
  relative_path: string;
  kind: StorageNodeKind;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  file_count: number;
  directory_count: number;
  child_count: number;
  children: StorageNode[];
  expandable: boolean;
  partial: boolean;
}
export interface StorageBreakdown {
  name: string;
  relative_path: string;
  kind: "directory" | "root-files";
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
}
export interface WorkspaceStorage {
  workspace_id: string;
  name: string;
  path: string;
  snapshot_version: number;
  root?: StorageNode;
  measurement: StorageMeasurement;
  quality: StorageQuality;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  file_count: number;
  directory_count: number;
  breakdown: StorageBreakdown[];
  last_attempt_at: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
}
export interface StorageWorkspace {
  id: string;
  name: string;
  path: string;
}
