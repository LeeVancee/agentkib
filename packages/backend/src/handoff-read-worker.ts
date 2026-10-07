import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { Commands, type CommandOutput } from "./commands";
import { BackendTaskError, TaskContext, runWithTask } from "./task-executor";
import {
  executeHandoffRead,
  type HandoffReadInput,
  type HandoffReadKind,
} from "./handoff-read-tasks";

if (!parentPort) throw new Error("Handoff reads require a Worker port");
const port = parentPort;
let running: { id: string; task: TaskContext } | undefined;
const pendingCommands = new Map<
  string,
  { resolve: (result: CommandOutput) => void; reject: (error: Error) => void }
>();
class ParentCommands extends Commands {
  override run(
    program: string,
    args: string[],
    options: Parameters<Commands["run"]>[2] = {},
  ): Promise<CommandOutput> {
    if (!running) return Promise.reject(new Error("No active handoff read"));
    running.task.checkpoint();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pendingCommands.set(id, { resolve, reject });
      port.postMessage({ kind: "command", id: running!.id, commandId: id, program, args, options });
    });
  }
}
const commands = new ParentCommands();
port.on(
  "message",
  (message: {
    kind: string;
    id: string;
    task?: { id: string; deadlineAt: number };
    operation?: HandoffReadKind;
    input?: HandoffReadInput<HandoffReadKind>;
    error?: string;
    value?: CommandOutput;
  }) => {
    if (message.kind === "command-result") {
      const pending = pendingCommands.get(message.id);
      if (!pending) return;
      pendingCommands.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve({ ...message.value!, bytes: Buffer.from(message.value!.bytes) });
      return;
    }
    if (message.kind === "cancel") {
      if (running?.id === message.id) running.task.cancel();
      return;
    }
    if (message.kind !== "read") return;
    if (running) {
      port.postMessage({ kind: "result", id: message.id, error: "Handoff read worker is busy" });
      return;
    }
    const task = new TaskContext(message.task!);
    running = { id: message.id, task };
    void runWithTask(task, async () => {
      try {
        task.checkpoint();
        const value = await executeHandoffRead(message.operation!, message.input!, commands);
        task.checkpoint();
        port.postMessage({ kind: "result", id: message.id, value });
      } catch (error) {
        port.postMessage({
          kind: "result",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
          reason: error instanceof BackendTaskError ? error.reason : undefined,
        });
      } finally {
        task.dispose();
        running = undefined;
      }
    });
  },
);
