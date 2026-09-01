import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);
const MEMORY_SETTLE_MS = 1_000;

interface StartupMark {
  name: string;
  elapsedMs: number;
}

export class StartupBenchmark {
  readonly #outputPath = process.env.AGENTKIB_STARTUP_BENCHMARK_FILE;
  readonly #startedAt = performance.now();
  readonly #marks: StartupMark[] = [];
  #runtimePid?: number;
  #completed = false;

  constructor() {
    this.mark("electron-main-start");
  }

  get enabled(): boolean {
    return Boolean(this.#outputPath);
  }

  hasMark(name: string): boolean {
    return this.#marks.some((mark) => mark.name === name);
  }

  mark(name: string): void {
    if (!this.enabled || this.#completed || this.#marks.some((mark) => mark.name === name)) return;
    this.#marks.push({ name, elapsedMs: roundMilliseconds(performance.now() - this.#startedAt) });
  }

  setRuntimePid(pid: number): void {
    this.#runtimePid = pid;
  }

  async complete(): Promise<void> {
    if (!this.#outputPath || this.#completed) return;
    this.mark("home-data-ready");
    this.#completed = true;
    await new Promise((resolve) => setTimeout(resolve, MEMORY_SETTLE_MS));
    const electronRssKb = app
      .getAppMetrics()
      .reduce((total, metric) => total + metric.memory.workingSetSize, 0);
    const runtimeRssKb = await processRssKb(this.#runtimePid);
    const payload = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      marks: this.#marks,
      memory: {
        electronRssKb,
        runtimeRssKb,
        combinedRssKb: electronRssKb + (runtimeRssKb ?? 0),
      },
    };
    await mkdir(path.dirname(this.#outputPath), { recursive: true });
    await writeFile(this.#outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

async function processRssKb(pid: number | undefined): Promise<number | undefined> {
  if (!pid || process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
