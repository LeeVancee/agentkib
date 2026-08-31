import { spawn } from "node:child_process";
import { backendError } from "../contracts.js";

export interface ManagedCommand {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  input?: string;
}
export interface ManagedOutput {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function runManaged(command: ManagedCommand): Promise<ManagedOutput> {
  if (!command.executable.trim()) throw backendError("VALIDATION", "Executable cannot be empty");
  if (command.signal?.aborted) throw backendError("CANCELLED", "Process cancelled");
  const limit = Math.max(1, command.maxOutputBytes ?? 2 * 1024 * 1024);
  const child = spawn(command.executable, command.args ?? [], {
    cwd: command.cwd,
    env: command.env ? { ...process.env, ...command.env } : process.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    truncated = false;
  const collect = (stream: NodeJS.ReadableStream, target: "stdout" | "stderr") =>
    stream.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = limit - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
      if (remaining <= 0) {
        truncated = true;
        terminate(child);
        return;
      }
      const text = chunk.toString("utf8");
      const bounded =
        Buffer.byteLength(text) > remaining
          ? Buffer.from(text).subarray(0, remaining).toString("utf8")
          : text;
      if (target === "stdout") stdout += bounded;
      else stderr += bounded;
      if (Buffer.byteLength(text) > remaining) {
        truncated = true;
        terminate(child);
      }
    });
  collect(child.stdout!, "stdout");
  collect(child.stderr!, "stderr");
  if (command.input !== undefined && child.stdin) {
    child.stdin.end(command.input);
  }
  const abort = () => terminate(child);
  command.signal?.addEventListener("abort", abort, { once: true });
  const timeout = command.timeoutMs ?? 15_000;
  const result = await new Promise<ManagedOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      terminate(child);
      reject(backendError("TIMEOUT", "Process timed out"));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(backendError("IO", error.message));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (command.signal?.aborted) reject(backendError("CANCELLED", "Process cancelled"));
      else resolve({ code, signal: signal ?? undefined, stdout, stderr, truncated });
    });
  });
  command.signal?.removeEventListener("abort", abort);
  return result;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else if (process.platform === "win32" && child.pid) {
      // npm/uv shims commonly fan out to a node/python child. Killing only the
      // shim leaves those descendants behind, so terminate the Windows process
      // tree explicitly before falling back to child.kill.
      const tree = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      tree.once("error", () => child.kill("SIGKILL"));
    } else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
