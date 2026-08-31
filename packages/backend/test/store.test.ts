import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendStore } from "../src/index.js";

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-store-"));
  return { root, store: BackendStore.open(path.join(root, "data", "agentkib.db")) };
}

describe("BackendStore", () => {
  test("persists workspace CRUD and exclusions", async () => {
    const { root, store } = await makeStore();
    const project = path.join(root, "project");
    await mkdir(project);
    const item = await store.addWorkspace({ path: project, name: "Demo" });
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(store.getWorkspace(item.id).name).toBe("Demo");
    expect(store.workspacePath(item.id)).toContain("project");
    store.excludeWorkspace(item.id);
    expect(store.listExcludedWorkspaces()).toHaveLength(1);
    await store.restoreExcludedWorkspace(item.canonical_path);
    expect(store.listExcludedWorkspaces()).toHaveLength(0);
    store.close();
    const reopened = BackendStore.open(path.join(root, "data", "agentkib.db"));
    expect(reopened.listWorkspaces()).toHaveLength(0);
    reopened.close();
  });

  test("supports memory proposal, FTS search, review and persistence", async () => {
    const { root, store } = await makeStore();
    const first = store.proposeMemory({
      project_id: "project-1",
      memory_type: "decision",
      content: "Prefer SQLite for local persistence",
    });
    const second = store.proposeMemory({
      project_id: "project-1",
      memory_type: "constraint",
      content: "Never expose private tokens",
    });
    store.proposeMemory({
      project_id: "project-2",
      memory_type: "decision",
      content: "SQLite elsewhere",
    });
    store.reviewMemory(first.id, "approved");
    expect(store.searchMemories("project-1", "SQLite")).toHaveLength(1);
    expect(store.listMemories("project-1", "pending")).toHaveLength(1);
    const reviewed = store.reviewMemory(
      second.id,
      "approved",
      "Never expose private tokens safely",
    );
    expect(reviewed.status).toBe("approved");
    expect(reviewed.approved_at).toBeTruthy();
    store.close();
    const reopened = BackendStore.open(path.join(root, "data", "agentkib.db"));
    expect(reopened.listMemories("project-1", "approved")).toHaveLength(2);
    reopened.close();
  });
});
