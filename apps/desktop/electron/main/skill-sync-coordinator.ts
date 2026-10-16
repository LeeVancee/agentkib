import {
  RUNTIME_METHODS,
  type SkillSyncCoordinatorState,
  type SkillSyncRun,
} from "@agentkib/runtime-protocol";
import type { RuntimeHost } from "./runtime-host";

/** Timers belong to the host; policy, due times and writes belong to the Skill worker. */
export class SkillSyncCoordinator {
  #started = false;
  #available = false;
  #suspended = false;
  #timer?: ReturnType<typeof setTimeout>;
  #flight?: Promise<void>;
  #failures = 0;
  constructor(
    private readonly options: {
      runtime(): RuntimeHost;
      onState(state: SkillSyncCoordinatorState): void;
    },
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(3_000);
  }
  stop(): void {
    this.#started = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  setRuntimeAvailable(available: boolean): void {
    this.#available = available;
    if (available) this.#schedule(2_000);
    else {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
  setSuspended(suspended: boolean): void {
    this.#suspended = suspended;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!suspended) this.#schedule(2_000);
  }
  #schedule(delay: number): void {
    if (!this.#started || !this.#available || this.#suspended || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick();
    }, delay);
    this.#timer.unref?.();
  }
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    if (!this.#started || !this.#available || this.#suspended) return Promise.resolve();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flight = (async () =>
      this.options.runtime().request<SkillSyncRun | null>(RUNTIME_METHODS.runDueSkillSync, {}))()
      .then((run) => {
        this.#failures = 0;
        if (this.#started && run)
          this.options.onState({
            state: "succeeded",
            checked_at: run.finished_at ?? run.started_at,
          });
      })
      .catch((error: unknown) => {
        this.#failures += 1;
        if (this.#started)
          this.options.onState({
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        this.#flight = undefined;
        this.#schedule(Math.min(60_000 * 2 ** this.#failures, 60 * 60_000));
      });
    return this.#flight;
  }
}
