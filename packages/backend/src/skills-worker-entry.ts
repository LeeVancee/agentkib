import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { Skills } from "./skills";
import { BackendTaskError, TaskContext, runWithTask, type TaskWorkspace } from "./task-executor";

if (!parentPort) throw new Error("Skills must run in a worker");
const port = parentPort;
const data = workerData as { environment: NodeJS.ProcessEnv; dataDir: string };
let workspaces: Array<{ id: string; path: string }> = [];
const skills = new Skills(data.environment, data.dataDir, () => workspaces);
let active: TaskContext | undefined;
const checks = new Map<string, { resolve(): void; reject(error: Error): void }>();

function verifyWorkspace(scope: TaskWorkspace): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkId = randomUUID();
    checks.set(checkId, { resolve, reject });
    port.postMessage({ type: "verify-workspace", id: active!.id, checkId, scope });
  });
}
type WorkerRequest =
  | { type: "workspace-result"; id: string; checkId: string; valid: boolean }
  | { type: "cancel"; id: string; reason: string }
  | { type: "close" }
  | {
      type: "run";
      id: string;
      deadlineAt: number;
      method: string;
      params: Record<string, unknown>;
      workspaces: Array<{ id: string; path: string }>;
    };
port.on("message", (message: WorkerRequest) => {
  if (message.type === "workspace-result") {
    if (message.id !== active?.id) return;
    const check = checks.get(message.checkId);
    checks.delete(message.checkId);
    if (message.valid === true) check?.resolve();
    else check?.reject(new Error("Skill workspace changed before applying the operation"));
    return;
  }
  if (message.type === "cancel") {
    if (message.id === active?.id)
      active.cancel(
        new BackendTaskError(
          message.reason === "deadline-exceeded" ? "deadline-exceeded" : "backend-closing",
        ),
      );
    return;
  }
  if (message.type === "close") {
    if (active) throw new Error("Cannot close a writing Skill worker");
    port.close();
    return;
  }
  if (message.type !== "run" || active) throw new Error("Invalid Skill worker dispatch");
  const task = new TaskContext({ id: message.id, deadlineAt: message.deadlineAt }, verifyWorkspace);
  active = task;
  workspaces = message.workspaces;
  void runWithTask(task, async () => {
    try {
      task.checkpoint();
      const result = await skills.request(message.method, message.params);
      // A completed local commit and a stale catalog remain truthful results after cancellation.
      const stale =
        message.method === "skills.listCatalog" &&
        result &&
        typeof result === "object" &&
        "stale" in result &&
        result.stale === true;
      if (!task.committed && !stale) task.checkpoint();
      port.postMessage({ type: "result", id: task.id, result });
    } catch (error) {
      port.postMessage({
        type: "error",
        id: task.id,
        message: error instanceof Error ? error.message : "Skill operation failed",
        reason: error instanceof BackendTaskError ? error.reason : undefined,
      });
    } finally {
      task.dispose();
      for (const check of checks.values()) check.reject(new Error("Skill request finished"));
      checks.clear();
      active = undefined;
    }
  });
});
