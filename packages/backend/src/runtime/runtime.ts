import { z } from "zod";
import { BackendStore } from "../store/store.js";
import { scanWorkspace } from "../workspace/scanner.js";
import { loadManifest } from "../workspace/manifest.js";
import { defaultManifest } from "../adapters/manifest.js";
import { workspaceSummary, history } from "../git/git.js";
import { discover } from "../discovery/discovery.js";
import { scanStorage } from "../storage/storage.js";
import { collectQuota, NodeQuotaRunner } from "../quota/quota.js";
import { backendError } from "../contracts.js";
import type { BackendMethodRegistry } from "../worker/host.js";
const id = z.object({ id: z.string() });
export interface BackendRuntimeOptions {
  database_path: string;
  scan_roots?: Array<{ path: string; max_depth?: number }>;
  quota_executable?: string;
}
export function createBackendRuntime(options: BackendRuntimeOptions) {
  const store = BackendStore.open(options.database_path);
  const publicWorkspace = (value: ReturnType<BackendStore["listWorkspaces"]>) =>
    value.map((workspace) => ({ ...workspace, path: workspace.canonical_path, sources: [] }));
  const registry: Record<string, (params: unknown, signal: AbortSignal) => unknown> = {
    "workspaces.list": () => publicWorkspace(store.listWorkspaces()),
    "workspace.scan": async (params, signal) => {
      const value = z.object({ project: z.string() }).parse(params);
      if (signal.aborted) throw backendError("CANCELLED", "Workspace scan cancelled");
      return scanWorkspace(value.project);
    },
    "workspace.prepareManifest": async (params) => {
      const value = z.object({ project: z.string() }).parse(params);
      try {
        return await loadManifest(value.project);
      } catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
        return defaultManifest(value.project);
      }
    },
    "workspace.refresh": async (params, signal) => {
      const value = z.object({ id: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.id);
      if (signal.aborted) throw backendError("CANCELLED", "Workspace refresh cancelled");
      return scanWorkspace(workspace.canonical_path);
    },
    "workspace.add": async (params) =>
      store
        .addWorkspace(
          z
            .object({
              path: z.string(),
              name: z.string().optional(),
              status: z.enum(["healthy", "attention"]).optional(),
            })
            .parse(params),
        )
        .then((workspace) => ({ ...workspace, path: workspace.canonical_path, sources: [] })),
    "workspace.exclude": (params) => {
      store.excludeWorkspace(id.parse(params).id);
      return { ok: true };
    },
    "workspace.restore": async (params) => {
      await store.restoreExcludedWorkspace(z.object({ path: z.string() }).parse(params).path);
      return { ok: true };
    },
    "workspace.restoreExcluded": async (params) => {
      await store.restoreExcludedWorkspace(z.object({ path: z.string() }).parse(params).path);
      return { ok: true };
    },
    "workspace.gitSummary": async (params) => {
      const value = z.object({ workspaceId: z.string() }).parse(params);
      return workspaceSummary(store.workspacePath(value.workspaceId));
    },
    "workspace.gitHistory": async (params) => {
      const value = z
        .object({ workspaceId: z.string(), query: z.record(z.string(), z.unknown()).default({}) })
        .parse(params);
      const query = value.query as {
        limit?: number;
        path?: string;
        author?: string;
        since?: string;
        until?: string;
      };
      return history(store.workspacePath(value.workspaceId), query);
    },
    "discovery.scan": async (_params, signal) => {
      if (signal.aborted) throw backendError("CANCELLED", "Discovery cancelled");
      return discover(options.scan_roots ?? []);
    },
    "storage.scan": async (params, signal) => {
      const value = z
        .object({
          id: z.string(),
          name: z.string(),
          path: z.string(),
          excluded_roots: z.array(z.string()).optional(),
        })
        .parse(params);
      return scanStorage(value, value.excluded_roots ?? [], signal);
    },
    "memories.propose": async (params) => {
      const value = z
        .object({
          project: z.string(),
          proposal: z.object({
            memory_type: z.enum([
              "user_preference",
              "project_fact",
              "decision",
              "constraint",
              "failed_attempt",
              "open_loop",
              "task_state",
              "agent_observation",
            ]),
            content: z.string(),
            source_agent: z.string().optional(),
            source_thread: z.string().optional(),
            source_reference: z.string().optional(),
          }),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.proposeMemory({ ...value.proposal, project_id: manifest.workspace.id });
    },
    "memories.list": async (params) => {
      const value = z
        .object({
          project: z.string(),
          status: z.enum(["pending", "approved", "rejected", "invalidated"]).nullable().optional(),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.listMemories(manifest.workspace.id, value.status ?? undefined);
    },
    "memories.search": async (params) => {
      const value = z
        .object({
          project: z.string(),
          query: z.string(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.searchMemories(manifest.workspace.id, value.query, value.limit);
    },
    "memories.review": (params) => {
      const value = z
        .object({
          id: z.string(),
          status: z.enum(["approved", "rejected", "invalidated"]),
          edited_content: z.string().optional(),
        })
        .parse(params);
      return store.reviewMemory(value.id, value.status, value.edited_content);
    },
    "quota.collect": async (_params, signal) =>
      collectQuota(
        new NodeQuotaRunner(options.quota_executable ?? "codexbar-cli"),
        undefined,
        30_000,
        signal,
      ),
  };
  return { registry: registry as BackendMethodRegistry, close: () => store.close() };
}
export function createBackendRegistry(options: BackendRuntimeOptions): BackendMethodRegistry {
  return createBackendRuntime(options).registry;
}
