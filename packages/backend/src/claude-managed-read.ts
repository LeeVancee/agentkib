import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveCommand } from "./command-resolution";
import { validHistoryControl } from "./history-control-schema";
import type { Commands } from "./commands";
import type { SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";
import { canonicalize, pathIdentity } from "./paths";
import { restrictRemotePath } from "./remote-tls";
import { acquirePortableFileLease } from "./managed-session-lock";
import { versionAtLeast } from "./native-version";
import {
  ClaudeHostStateStore,
  validClaudeDeviceId,
  claudeCommandFingerprint,
  type ClaudeHostWork,
  type ClaudeSettings,
} from "./claude-host-state";
import { createClaudeGoalReportEndpoint } from "./claude-goal-report";
import { projectContextUsage } from "./context-usage";
import {
  ClaudeManagedRunnerProcess,
  ClaudeUndispatchedError,
  type ClaudeRunnerSnapshot,
  validateClaudeContent,
} from "./claude-managed-runner";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  replayManagedCommand,
  readUnknownManagedCommands,
  openManagedLedger,
} from "./managed-ledger";

export function supportsClaudeVersion(value: string, minimum = "2.1.263"): boolean {
  const match = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(value);
  return match !== null && versionAtLeast(match[1]!, minimum);
}

/** The requested mutation is durably rejected before any external effect. */
export class ClaudeHostControlPreflightError extends Error {
  constructor(
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClaudeHostControlPreflightError";
  }
}
const FILE_LIMIT = 2 * 1024 * 1024;
type ClaudeRecord = {
  version: 1;
  id: string;
  workspaceId: string;
  workspace: string;
  registeredWorkspace: string | null;
  home: string;
  nativeId: string;
  title: string;
  createdAt: string;
  adopted: boolean;
  released: boolean;
  fresh: boolean;
  fingerprint: string | null;
  snapshot: Record<string, unknown>;
  completedRequests: string[];
  forkSourceNativeId?: string;
  forkCutoff?: string;
  nativeTitle?: string;
};
const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sessionIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const supportsClaudeManagedRunner = () =>
  process.platform === "darwin" || process.platform === "linux";
type ClaudeConversationPublisher = (
  sessionId: string,
  type: "state" | "text-delta" | "item-upsert" | "snapshot",
  payload: Record<string, unknown>,
  live: Record<string, unknown>,
) => void;
type ClaudeConversationAliaser = (
  sessionId: string,
  previousId: string,
  itemId: string,
  live: Record<string, unknown>,
) => void;

/** Manages Claude session ownership, CLI runners, and read-side state. */
export class ClaudeManagedReadOwner {
  #version?: { at: number; value: string | null };
  #runners = new Map<string, ClaudeManagedRunnerProcess>();
  #hostState: ClaudeHostStateStore;
  #scheduleEpoch = 0;
  #sessionScheduleEpochs = new Map<string, number>();
  #deviceScheduleEpochs = new Map<string, number>();
  #permits = new Map<
    string,
    { sessionId: string; item: ClaudeHostWork; expiresAt: number; revision: number }
  >();
  #goalEndpoints = new Map<string, { close(): Promise<void> }>();
  #goalRunners = new Set<string>();
  #runnerReservations = new Set<string>();
  #runnerReservationTail: Promise<void> = Promise.resolve();
  #ownerLocks = new Map<string, () => void>();
  #sessionQueues = new Map<string, Promise<void>>();
  #publishConversationEvent?: ClaudeConversationPublisher;
  #aliasConversationItem?: ClaudeConversationAliaser;

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly commands: Commands,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly bootId = randomUUID(),
    publishers?: {
      publish: ClaudeConversationPublisher;
      alias: ClaudeConversationAliaser;
    },
  ) {
    this.#hostState = new ClaudeHostStateStore(dataDir, bootId);
    this.#publishConversationEvent = publishers?.publish;
    this.#aliasConversationItem = publishers?.alias;
  }

  close(): void {
    void this.shutdown().catch(() => undefined);
  }

  invalidateSchedulePermits(sessionId?: string, deviceId?: string): void {
    if (sessionId)
      this.#sessionScheduleEpochs.set(
        sessionId,
        (this.#sessionScheduleEpochs.get(sessionId) ?? 0) + 1,
      );
    else if (deviceId)
      this.#deviceScheduleEpochs.set(deviceId, (this.#deviceScheduleEpochs.get(deviceId) ?? 0) + 1);
    else this.#scheduleEpoch++;
    for (const [key, permit] of this.#permits)
      if (
        (!sessionId || permit.sessionId === sessionId) &&
        (!deviceId || permit.item.deviceId === deviceId)
      ) {
        this.#permits.delete(key);
        this.#hostState.releaseClaim(permit.sessionId, permit.item.id);
      }
  }

  #scheduleGeneration(sessionId: string, deviceId: string): string {
    return `${this.#scheduleEpoch}:${this.#sessionScheduleEpochs.get(sessionId) ?? 0}:${this.#deviceScheduleEpochs.get(deviceId) ?? 0}`;
  }

  async shutdown(): Promise<void> {
    this.invalidateSchedulePermits();
    await Promise.allSettled([...this.#goalEndpoints.values()].map((endpoint) => endpoint.close()));
    this.#goalEndpoints.clear();
    const runners = [...this.#runners.entries()];
    const results = await Promise.allSettled(
      runners.map(async ([id, runner]) => {
        await runner.shutdown();
        if (this.#runners.get(id) !== runner) return;
        this.#runners.delete(id);
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const [id, release] of this.#ownerLocks) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
      this.#ownerLocks.delete(id);
    }
    if (failures.length)
      throw new AggregateError(failures, "Claude managed runner shutdown failed");
  }

  async request(value: unknown): Promise<unknown> {
    if (!isObject(value) || typeof value.operation !== "string") throw new Error("invalid-request");
    const id = typeof value.sessionId === "string" ? value.sessionId : undefined;
    if (value.operation === "schedule-pause" || value.operation === "schedule-invalidate")
      this.invalidateSchedulePermits(
        id,
        typeof value.deviceId === "string" ? value.deviceId : undefined,
      );
    const run = () => this.#requestLocked(value, id);
    return id ? this.#serializeSession(id, run) : run();
  }

  async #requestLocked(value: Record<string, any>, id?: string): Promise<unknown> {
    const readOperations = new Set([
      "live",
      "capabilities",
      "inspect",
      "context",
      "events",
      "settings-state",
      "usage",
      "goal",
      "resources",
      "reconcile",
      "queue-list",
    ]);
    const hasRecord = id !== undefined && this.#load(id) !== null;
    const ownedHere = id !== undefined && this.#ownerLocks.has(id);
    const hasRunner = id !== undefined && this.#runners.has(id);
    const release =
      hasRecord && readOperations.has(value.operation) && !ownedHere && !hasRunner
        ? this.#tryLock(id!)
        : null;
    if (hasRecord && readOperations.has(value.operation) && !release && !ownedHere && !hasRunner)
      throw new Error("session-managed-by-another-runtime");
    if (release) this.#ownerLocks.set(id!, release);
    try {
      return await this.#requestRead(value, id);
    } finally {
      if (release && !this.#runners.has(id!)) {
        this.#ownerLocks.delete(id!);
        release();
      }
    }
  }

  async #serializeSession<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#sessionQueues.get(id) ?? Promise.resolve();
    const current = previous.then(run);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionQueues.set(id, tail);
    try {
      return await current;
    } finally {
      if (this.#sessionQueues.get(id) === tail) this.#sessionQueues.delete(id);
    }
  }

  async #requestRead(value: Record<string, any>, id?: string): Promise<unknown> {
    switch (value.operation) {
      case "options":
        return this.options();
      case "create":
        return this.#create(value);
      case "adopt":
        if (!id) throw new Error("missing-session");
        return this.#adopt(value, id);
      case "release":
        if (!id) throw new Error("missing-session");
        return this.#release(value, id);
      case "send":
      case "steer":
      case "stop":
      case "approve":
      case "answer":
        if (!id) throw new Error("missing-session");
        return this.#control(value, id);
      case "live":
        if (!id) throw new Error("missing-session");
        return this.live(id, value.experimentalEnabled === true);
      case "capabilities":
        if (!id) throw new Error("missing-session");
        return this.capabilities(id, value.experimentalEnabled === true);
      case "inspect":
        if (!id) throw new Error("missing-session");
        return this.inspect(id, value.experimentalEnabled === true);
      case "context":
        if (!id) throw new Error("missing-session");
        return this.context(id);
      case "events":
        if (!id) throw new Error("missing-session");
        return this.events(id, value.cursor, value.limit);
      case "settings-state":
        if (!id) throw new Error("missing-session");
        return this.settingsState(id);
      case "goal":
        if (!id) throw new Error("missing-session");
        await this.#live(id, false);
        return {
          available: true,
          goal: this.#hostState.read(id).goal,
          revision: (await this.#live(id, false)).revision,
          executionMode: "claude-managed",
        };
      case "resources":
        if (!id) throw new Error("missing-session");
        return this.#resources(id);
      case "queue-list":
        if (!id) throw new Error("missing-session");
        await this.#live(id, false);
        return this.#queue(id);
      case "schedule-list":
        return this.#scheduleList(id);
      case "schedule-invalidate":
        this.invalidateSchedulePermits(id, value.deviceId);
        return { ok: true };
      case "schedule-prepare":
      case "schedule-dispatch":
      case "schedule-pause":
      case "schedule-resume":
        if (!id) throw new Error("missing-session");
        return this.#schedule(value, id);
      case "settings":
      case "queue-add":
      case "queue-update":
      case "queue-delete":
      case "queue-reorder":
      case "queue-resume":
      case "queue-pause":
      case "rename":
      case "archive":
      case "unarchive":
      case "goal-set":
      case "goal-pause":
      case "goal-resume":
      case "goal-clear":
      case "fork":
        if (!id) throw new Error("missing-session");
        return this.#hostControl(value, id);
      case "usage": {
        if (!id) throw new Error("missing-session");
        const live = await this.#live(id, false);
        return {
          ...projectContextUsage(
            live.usage ?? { available: false, state: "unavailable" },
            Number(live.revision),
          ),
          executionMode: "claude-managed",
        };
      }
      case "reconcile":
        if (!id) throw new Error("missing-session");
        return this.#reconcile(value, id);
      default:
        throw new Error(`unsupported-Claude-managed-operation:${value.operation}`);
    }
  }

  async #control(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const operation = value.operation as string;
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "text",
      "input",
      "resourceRefs",
      "historyReferences",
      "historyInputHash",
      "turnId",
      "approvalId",
      "questionId",
      "answers",
      "decision",
      "schedulePermitId",
      "publicInputHash",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.runtimeBootId !== this.bootId ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      value.experimentalEnabled !== true
    )
      throw new Error("invalid-managed-control");
    if (
      value.publicInputHash !== undefined &&
      (typeof value.publicInputHash !== "string" || !/^[a-f0-9]{64}$/.test(value.publicInputHash))
    )
      throw new Error("invalid-public-input-hash");
    if (!validHistoryControl({ ...value, operation })) throw new Error("invalid-history-reference");
    if (
      operation === "steer" &&
      !supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286")
    )
      throw new Error("unsupported-Claude-version");

    const record = this.#load(id);
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    this.#validate(record);
    let existingRunner = this.#runners.get(id);
    if (operation !== "send" && !existingRunner) throw new Error("session-runner-unavailable");
    if (managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    let live = await this.#live(id, true);
    if (live.status === "archived") throw new Error("session-archived");
    if (live.status === "outcome-unknown") throw new Error("control-outcome-unconfirmed");

    const logical = { ...value };
    delete logical.runtimeBootId;
    delete logical.schedulePermitId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
    if (operation === "send" && live.activity === "compacting")
      return this.#compactingResult(id, requestId);
    if (value.expectedRevision !== live.revision) throw new Error("stale-Claude-revision");
    if (
      operation === "send" &&
      live.status === "idle" &&
      this.#goalRunners.has(id) &&
      !this.#goalEndpoints.has(id)
    ) {
      await this.#retireGoalRunner(id);
      existingRunner = undefined;
      record.snapshot = this.#load(id)!.snapshot;
      live = await this.#live(id, true);
    }

    if (operation === "send" && !value.schedulePermitId) {
      const host = this.#hostState.read(id);
      if (host.goal?.status === "active")
        this.#hostState.update(id, (state) => {
          state.goal!.status = "paused";
          state.goal!.reason = "user-message";
        });
      this.invalidateSchedulePermits(id);
    }
    let content: unknown;
    let executable: string | null | undefined;
    let newlyAcquiredOwnerLock = false;
    if (operation === "send" || operation === "steer") {
      if (operation === "send" && live.sendEnabled !== true) throw new Error("session-busy");

      if (value.resourceRefs !== undefined && !Array.isArray(value.resourceRefs))
        throw new Error("invalid-resource-references");
      content = this.#resourceInput(
        record,
        value.input ?? (typeof value.text === "string" ? value.text : undefined),
        value.resourceRefs,
      );
      if (content === undefined) throw new Error("missing-input");
      validateClaudeContent(content);
      if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
      executable = resolveCommand("claude", this.environment);
      if (!executable) throw new Error("claude-cli-unavailable");
      if (!existingRunner) {
        // Creating/adopting an idle session already retains this runtime's lease.
        // A second file-lock acquisition would reject our own first send.
        if (!this.#ownerLocks.has(id)) {
          const release = this.#tryLock(id);
          if (!release) throw new Error("session-managed-by-another-runtime");
          this.#ownerLocks.set(id, release);
          newlyAcquiredOwnerLock = true;
        }
        try {
          this.#ensureNoExternalOwner(record.nativeId);
          if (!record.fresh) {
            const target = await this.#resolveNative(record.id);
            if (target.nativeId !== record.nativeId || record.fingerprint !== target.fingerprint)
              throw new Error("Claude-history-changed-requires-handoff");
          }
        } catch (error) {
          if (newlyAcquiredOwnerLock) {
            const release = this.#ownerLocks.get(id);
            this.#ownerLocks.delete(id);
            release?.();
          }
          throw error;
        }
      }
    }
    const inputFingerprint =
      content === undefined ? null : createHash("sha256").update(stableJson(content)).digest("hex");
    const evidence = {
      operation,
      workspaceId: record.workspaceId,
      runtimeBootId: this.bootId,
      expectedRevision: value.expectedRevision,
      turnId: value.turnId ?? null,
      inputFingerprint,
      executionMode: "claude-managed",
      ...(value.historyInputHash ? { historyInputHash: value.historyInputHash } : {}),
      ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
    };
    let reservedRunnerSlot = false;
    try {
      if (operation === "send") reservedRunnerSlot = await this.#reserveRunner(id);
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        if (newlyAcquiredOwnerLock) {
          const release = this.#ownerLocks.get(id);
          this.#ownerLocks.delete(id);
          release?.();
        }
        return claimed;
      }

      const previousSnapshot = structuredClone(record.snapshot);
      record.snapshot = { ...live, status: "outcome-unknown" };
      this.#save(record);
      let dispatched = false;
      if (operation !== "send") {
        dispatchManagedCommand(this.dataDir, requestId);
        dispatched = true;
      }
      let runner = existingRunner;
      if (!runner) {
        runner = this.#newRunner(record);
      }

      try {
        switch (operation) {
          case "send": {
            const dispatch = runner.send(
              executable!,
              content,
              requestId,
              runner.snapshot().revision,
              () => {
                if (runner.snapshot().activity === "compacting")
                  throw new ClaudeUndispatchedError();
                if (value.schedulePermitId) {
                  const permit = this.#permits.get(value.schedulePermitId);
                  if (
                    !permit ||
                    permit.sessionId !== id ||
                    permit.item.requestId !== requestId ||
                    permit.item.deviceId !== value.deviceId ||
                    permit.expiresAt < Date.now()
                  )
                    throw new ClaudeUndispatchedError();
                  this.#hostState.dispatched(id, permit.item.id);
                  this.#permits.delete(value.schedulePermitId);
                }
                dispatchManagedCommand(this.dataDir, requestId);
                dispatched = true;
              },
            );
            if (reservedRunnerSlot) {
              this.#runnerReservations.delete(id);
              reservedRunnerSlot = false;
            }
            await dispatch;
            record.fresh = false;
            break;
          }
          case "steer":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.steer(content, requestId, value.turnId, runner.snapshot().revision);
            break;
          case "stop":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.stop(value.turnId, runner.snapshot().revision);
            this.#hostState.complete(id, value.turnId, {
              success: false,
              usage: null,
              cancelled: true,
            });
            this.#hostState.pause(id, "cancelled");
            this.invalidateSchedulePermits(id);
            break;
          case "approve":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.approve(
              value.approvalId,
              value.turnId,
              value.decision,
              runner.snapshot().revision,
            );
            break;
          case "answer":
            if (typeof value.turnId !== "string") throw new Error("missing-turn");
            await runner.answer(
              value.questionId,
              value.turnId,
              value.answers,
              runner.snapshot().revision,
            );
            break;
          default:
            throw new Error("unsupported-Claude-control");
        }
        const snapshot = runner.snapshot();
        const current = this.#load(id)!;
        current.snapshot = snapshot as unknown as Record<string, unknown>;
        if (operation === "send") current.fresh = false;
        this.#save(current);
        const result = {
          accepted: true,
          completed: false,
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
          controlOutcome: "accepted",
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
          live: await this.#live(id, true),
        };
        finishManagedCommand(this.dataDir, requestId, result);
        return result;
      } catch (error) {
        const current = this.#load(id);
        if (current) {
          current.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(current);
        } else {
          record.snapshot = previousSnapshot;
        }
        const unknown =
          !dispatched && error instanceof ClaudeUndispatchedError
            ? false
            : current?.snapshot.status === "outcome-unknown";
        const result = {
          accepted: false,
          completed: false,
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
          controlOutcome: unknown ? "unknown" : "not-dispatched",
          error: error instanceof Error ? error.message : String(error),
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
        };
        if (!unknown) finishManagedCommand(this.dataDir, requestId, result);
        return result;
      }
    } finally {
      // The slot is handed to a live worker when send starts; failures before then
      // release it here so another session can claim the available capacity.
      if (reservedRunnerSlot) this.#runnerReservations.delete(id);
    }
  }

  #newRunner(
    record: ClaudeRecord,
    options: { mcpConfig?: Record<string, unknown> } = {},
    settings = this.#hostState.read(record.id).settings,
  ): ClaudeManagedRunnerProcess {
    const id = record.id;
    const runner = new ClaudeManagedRunnerProcess(
      record.workspace,
      record.nativeId,
      record.fresh,
      Number(record.snapshot.revision ?? 0),
      this.environment,
      (snapshot: ClaudeRunnerSnapshot) => {
        const current = this.#load(id);
        if (!current || current.released) throw new Error("Claude session unavailable");
        const turnId = snapshot.turnId;
        let completed = false;
        if (
          snapshot.status === "idle" &&
          typeof turnId === "string" &&
          turnId.length > 0 &&
          !current.completedRequests.includes(turnId)
        ) {
          try {
            current.fingerprint = this.#targetFingerprint(current.nativeId, current.workspace);
            const title = this.#hostState.read(id).title;
            if (title && title !== current.nativeTitle) this.#persistNativeTitle(current, title);
          } catch {
            // Completion is still recorded; a missing transcript cannot prove a new handoff.
          }
          current.completedRequests.push(turnId);
          completed = true;
        }
        current.snapshot = snapshot as unknown as Record<string, unknown>;
        if (snapshot.status === "outcome-unknown" && snapshot.turnId)
          this.#hostState.complete(id, snapshot.turnId, {
            success: false,
            usage: null,
            unknown: true,
          });
        this.#save(current);
        if (completed) this.#recoverCompletions(current);
        const streamLive = this.#streamLive(id, snapshot, current);
        this.#publishConversationEvent?.(id, "state", streamLive, streamLive);
      },
      supportsClaudeVersion(this.#version?.value ?? "", "2.1.285"),
      (type, payload, live) => {
        if (type === "item-alias")
          this.#aliasConversationItem?.(
            id,
            String(payload.previousId),
            String(payload.itemId),
            this.#streamLive(id, live),
          );
        else {
          const streamLive = this.#streamLive(id, live);
          this.#publishConversationEvent?.(id, type, payload, streamLive);
        }
      },
      {
        ...settings,
        ...(record.fresh && record.forkSourceNativeId
          ? { forkSourceNativeId: record.forkSourceNativeId, forkCutoff: record.forkCutoff }
          : {}),
        ...options,
        onResult: (result) => {
          this.#hostState.complete(id, result.turnId, {
            success: result.success,
            usage: result.usage,
          });
          void this.#goalEndpoints
            .get(id)
            ?.close()
            .catch(() => this.#hostState.pause(id, "goal-report-close-failed"));
          this.#goalEndpoints.delete(id);
        },
      },
    );
    this.#runners.set(id, runner);
    if (options.mcpConfig) this.#goalRunners.add(id);
    return runner;
  }

  async #retireGoalRunner(id: string): Promise<void> {
    const runner = this.#runners.get(id);
    if (runner) await runner.shutdown();
    this.#runners.delete(id);
    this.#goalRunners.delete(id);
  }

  #queue(id: string): Record<string, unknown> {
    const state = this.#hostState.read(id);
    return {
      available: true,
      revision: state.revision,
      paused: state.paused,
      requiresResume: state.paused,
      reason: state.reason,
      data: state.work
        .filter(
          (item) =>
            item.kind === "queue" &&
            ["pending", "claimed", "dispatched", "unknown"].includes(item.status),
        )
        .map((item) => ({
          id: item.id,
          clientUserMessageId: item.originRequestId,
          requestId: item.requestId,
          deviceId: item.deviceId,
          input: typeof item.input === "string" ? [{ type: "text", text: item.input }] : item.input,
          status: item.status,
          createdAt: item.createdAt,
          requiresAttachments: item.requiresAttachments,
        })),
      nextCursor: null,
    };
  }

  #settings(value: Record<string, unknown>, previous: ClaudeSettings = {}): ClaudeSettings {
    if (value.resetDefaults === true) return {};
    const result = { ...previous };
    if (value.model !== undefined) {
      if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 256)
        throw new Error("invalid-model");
      result.model = value.model;
    }
    if (value.effort !== undefined) {
      if (value.effort === null) delete result.effort;
      else if (!["low", "medium", "high", "xhigh", "max"].includes(String(value.effort)))
        throw new Error("unsupported-effort");
      else result.effort = value.effort as ClaudeSettings["effort"];
    }
    if (value.permissionMode !== undefined) {
      if (!["default", "plan", "acceptEdits"].includes(String(value.permissionMode)))
        throw new Error("unsupported-permission-mode");
      result.permissionMode = value.permissionMode as ClaudeSettings["permissionMode"];
    }
    return result;
  }

  async #prepareRunner(
    record: ClaudeRecord,
    options: { mcpConfig?: Record<string, unknown> } = {},
    settings?: ClaudeSettings,
  ): Promise<ClaudeManagedRunnerProcess> {
    if (
      !options.mcpConfig &&
      this.#goalRunners.has(record.id) &&
      !this.#goalEndpoints.has(record.id)
    ) {
      await this.#retireGoalRunner(record.id);
      record = this.#load(record.id)!;
    }
    if (!this.#ownerLocks.has(record.id)) {
      const release = this.#tryLock(record.id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(record.id, release);
    }
    let runner = this.#runners.get(record.id);
    if (!runner?.hasWorker) {
      this.#ensureNoExternalOwner(record.nativeId);
      if (!record.fresh) {
        const target = await this.#resolveNative(record.id);
        if (target.nativeId !== record.nativeId || target.fingerprint !== record.fingerprint)
          throw new Error("Claude-history-changed-requires-handoff");
      }
      if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
      await this.#reserveRunner(record.id);
      runner = this.#newRunner(record, options, settings);
    }
    const executable = resolveCommand("claude", this.environment);
    if (!executable) throw new Error("claude-cli-unavailable");
    try {
      await runner.prepare(executable);
    } finally {
      this.#runnerReservations.delete(record.id);
    }
    return runner;
  }

  #persistNativeTitle(record: ClaudeRecord, title: string): void {
    this.#ensureNoExternalOwner(record.nativeId, this.#runners.get(record.id)?.processId ?? null);
    if (record.fingerprint !== this.#targetFingerprint(record.nativeId, record.workspace))
      throw new Error("Claude-history-changed-requires-handoff");
    if (record.nativeTitle === title) return;
    const transcript = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
    const target = lstatSync(transcript);
    const fd = openSync(transcript, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== target.dev ||
        before.ino !== target.ino ||
        before.size > 128 * 1024 * 1024
      )
        throw new Error("invalid-Claude-transcript");
      const row = Buffer.from(
        `${before.size && !readFileSync(transcript).subarray(-1).equals(Buffer.from("\n")) ? "\n" : ""}${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: record.nativeId })}\n`,
      );
      if (writeSync(fd, row) !== row.length) throw new Error("Claude-title-write-incomplete");
      fsyncSync(fd);
      const after = fstatSync(fd);
      const verified = lstatSync(transcript);
      if (
        after.size !== before.size + row.length ||
        after.nlink !== 1 ||
        verified.nlink !== 1 ||
        verified.ino !== after.ino ||
        verified.dev !== after.dev ||
        !readFileSync(transcript).subarray(-row.length).equals(row)
      )
        throw new Error("Claude-title-write-unconfirmed");
    } finally {
      closeSync(fd);
    }
    record.fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
    record.nativeTitle = title;
    this.#save(record);
  }

  #completedTurnIncludesUser(record: ClaudeRecord, turnId: string, userId: unknown): boolean {
    if (turnId === userId) return true;
    if (typeof userId !== "string" || !uuidPattern.test(userId)) return false;
    const database = openManagedLedger(this.dataDir);
    if (!database) return false;
    try {
      const row = database
        .prepare(
          "SELECT evidence,result FROM managed_commands WHERE request_id=? AND session_id=? AND phase='resolved'",
        )
        .get(userId, record.id) as { evidence: string | null; result: string | null } | undefined;
      if (!row?.evidence || !row.result) return false;
      const evidence: unknown = JSON.parse(row.evidence);
      const result: unknown = JSON.parse(row.result);
      return (
        isObject(evidence) &&
        evidence.operation === "steer" &&
        evidence.executionMode === "claude-managed" &&
        evidence.turnId === turnId &&
        isObject(result) &&
        result.accepted === true &&
        result.controlOutcome === "accepted"
      );
    } finally {
      database.close();
    }
  }

  async #hostControl(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    let externalClaimStarted = false;
    try {
      return await this.#hostControlImpl(value, id, () => {
        externalClaimStarted = true;
      });
    } catch (error) {
      if (
        externalClaimStarted ||
        !sessionIdPattern.test(id) ||
        !validClaudeDeviceId(value.deviceId) ||
        typeof value.requestId !== "string" ||
        !uuidPattern.test(value.requestId)
      )
        throw error;
      try {
        // An existing claim or committed receipt is stronger evidence than local exception timing.
        const database = openManagedLedger(this.dataDir);
        if (database) {
          try {
            if (
              database
                .prepare("SELECT request_id FROM managed_commands WHERE request_id=?")
                .get(value.requestId)
            )
              throw error;
          } finally {
            database.close();
          }
        }
        const record = this.#load(id);
        if (!record || record.released || !this.#ownerLocks.has(id)) throw error;
        this.#validate(record);
        const result = this.#hostState.command(id, value, record.workspaceId, () => ({
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          error: "control-preflight-rejected",
        }));
        if (result.controlOutcome !== "not-dispatched") throw error;
        throw new ClaudeHostControlPreflightError(
          error instanceof Error ? error.message : "control-preflight-rejected",
          result,
        );
      } catch (recordingError) {
        if (recordingError instanceof ClaudeHostControlPreflightError) throw recordingError;
        throw error;
      }
    }
  }

  async #hostControlImpl(
    value: Record<string, any>,
    id: string,
    onExternalClaim: () => void,
  ): Promise<Record<string, unknown>> {
    const operation = value.operation as string;
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "name",
      "model",
      "effort",
      "permissionMode",
      "resetDefaults",
      "goal",
      "text",
      "input",
      "resourceRefs",
      "historyReferences",
      "historyInputHash",
      "queuedSubmissionId",
      "queuedSubmissionIds",
      "handoffConfirmed",
      "turnId",
      "publicInputHash",
    ]);
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof value.requestId !== "string" ||
      !uuidPattern.test(value.requestId) ||
      value.runtimeBootId !== this.bootId ||
      value.experimentalEnabled !== true ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-control");
    if (!validHistoryControl({ ...value, operation })) throw new Error("invalid-history-reference");
    if (
      value.publicInputHash !== undefined &&
      (typeof value.publicInputHash !== "string" || !/^[a-f0-9]{64}$/.test(value.publicInputHash))
    )
      throw new Error("invalid-public-input-hash");
    const prior = replayManagedCommand(
      this.dataDir,
      value.requestId,
      claudeCommandFingerprint(value),
    );
    if (prior) return prior;
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
    const record = this.#load(id);
    if (!record || record.released) throw new Error("session-unavailable");
    this.#validate(record);
    if (!this.#ownerLocks.has(id)) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    const live = await this.#live(id, true);
    if (live.status === "outcome-unknown" || managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    if (live.revision !== value.expectedRevision) throw new Error("stale-Claude-revision");
    const state = this.#hostState.read(id);
    if (state.archived && operation !== "unarchive") throw new Error("session-archived");
    if (
      [
        "settings",
        "rename",
        "archive",
        "unarchive",
        "fork",
        "goal-set",
        "goal-resume",
        "queue-resume",
      ].includes(operation) &&
      ((live.status !== "idle" && live.status !== "archived") || live.activity === "compacting")
    )
      throw new Error("session-busy");
    let nextSettings: ClaudeSettings | undefined;
    let renamedTitle: string | undefined;
    let externallyDispatched = false;
    const claimExternalEffect = () => {
      onExternalClaim();
      const prior = claimManagedCommand(
        this.dataDir,
        value.requestId,
        id,
        claudeCommandFingerprint(value),
        value.deviceId,
        {
          operation,
          workspaceId: record.workspaceId,
          executionMode: "claude-managed",
          runtimeBootId: this.bootId,
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
        },
      );
      if (prior) throw new Error("control-outcome-unconfirmed");
      dispatchManagedCommand(this.dataDir, value.requestId);
      externallyDispatched = true;
    };
    if (operation === "settings") {
      nextSettings = this.#settings(value, state.settings);
      let runner = await this.#prepareRunner(record);
      const models = runner.optionsSnapshot.models;
      const model = nextSettings.model ?? runner.optionsSnapshot.settings.model;
      if (nextSettings.model && !models.some((model) => model.value === nextSettings!.model))
        throw new Error("unsupported-model");
      if (
        nextSettings.effort &&
        !models
          .find((option) => option.value === model || option.resolvedModel === model)
          ?.supportedEffortLevels?.includes(nextSettings.effort)
      )
        throw new Error("unsupported-effort");
      claimExternalEffect();
      if (value.resetDefaults === true || value.effort === null) {
        // Native effortLevel:null selects CLI defaults rather than inherited host settings.
        // Relaunch without only the cleared override so live and restarted behavior agree.
        await runner.shutdown();
        this.#runners.delete(id);
        runner = await this.#prepareRunner(this.#load(id)!, {}, nextSettings);
      } else {
        await runner.configure(this.#settings(value), runner.snapshot().revision);
      }
    }
    if (operation === "rename") {
      if (
        typeof value.name !== "string" ||
        !value.name.trim() ||
        Buffer.byteLength(value.name) > 512 ||
        [...value.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("invalid-session-name");
      renamedTitle = value.name;
      if (!record.fresh) {
        if (record.fingerprint !== this.#targetFingerprint(record.nativeId, record.workspace))
          throw new Error("Claude-history-changed-requires-handoff");
        const transcript = this.sessions.verifiedClaudeControlTarget(
          record.nativeId,
          record.workspace,
        );
        if (lstatSync(transcript).nlink !== 1) throw new Error("invalid-Claude-transcript");
        claimExternalEffect();
        this.#persistNativeTitle(record, renamedTitle!);
      }
    }
    let fork: ClaudeRecord | undefined;
    if (operation === "fork") {
      if (record.fresh) throw new Error("fork-history-unavailable");
      this.#ensureNoExternalOwner(record.nativeId, this.#runners.get(record.id)?.processId ?? null);
      const fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
      if (record.fingerprint !== fingerprint)
        throw new Error("Claude-history-changed-requires-handoff");
      const transcript = this.sessions.verifiedClaudeControlTarget(
        record.nativeId,
        record.workspace,
      );
      const lines = readFileSync(transcript, "utf8").trim().split("\n");
      if (this.#targetFingerprint(record.nativeId, record.workspace) !== fingerprint)
        throw new Error("Claude-history-changed-requires-handoff");
      const rows = lines.reverse().map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
      const last = rows.find(
        (row) =>
          row &&
          row.sessionId === record.nativeId &&
          ["assistant", "user"].includes(row.type) &&
          typeof row.uuid === "string" &&
          uuidPattern.test(row.uuid),
      );
      const lastUser = rows.find(
        (row) => row?.type === "user" && row.sessionId === record.nativeId,
      );
      const terminal = record.snapshot.terminalResult;
      const confirmedManagedTurn =
        isObject(terminal) &&
        terminal.success === true &&
        typeof terminal.turnId === "string" &&
        this.#completedTurnIncludesUser(record, terminal.turnId, lastUser?.uuid) &&
        record.completedRequests.includes(terminal.turnId);
      if (
        last?.type !== "assistant" ||
        (!confirmedManagedTurn &&
          !["end_turn", "stop_sequence"].includes(last.message?.stop_reason))
      )
        throw new Error("fork-cutoff-unavailable");
      if (!last) throw new Error("fork-cutoff-unavailable");
      const existingFork = this.#load(value.requestId);
      if (
        existingFork &&
        (existingFork.forkSourceNativeId !== record.nativeId ||
          existingFork.forkCutoff !== last.uuid)
      )
        throw new Error("fork-request-conflict");
      claimExternalEffect();
      fork = existingFork ?? {
        ...record,
        id: value.requestId,
        nativeId: value.requestId,
        createdAt: new Date().toISOString(),
        adopted: false,
        title: `${state.title ?? record.title} (fork)`,
        fresh: true,
        fingerprint: null,
        forkSourceNativeId: record.nativeId,
        forkCutoff: last.uuid,
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
        completedRequests: [],
      };
      this.#save(fork);
      this.#hostState.update(fork.id, (target) => {
        target.settings = { ...state.settings };
      });
    }
    const result = this.#hostState.command(
      id,
      value,
      record.workspaceId,
      (host) => {
        switch (operation) {
          case "settings":
            host.settings = nextSettings!;
            return { settings: host.settings };
          case "rename": {
            host.title = renamedTitle!;
            return { name: renamedTitle };
          }
          case "archive":
            host.archived = true;
            host.paused = true;
            host.reason = "archived";
            if (host.goal?.status === "active") {
              host.goal.status = "paused";
              host.goal.reason = "archived";
            }
            return {};
          case "unarchive":
            host.archived = false;
            host.paused = true;
            host.reason = "resume-confirmation-required";
            return {};
          case "fork":
            return {
              sessionId: fork!.id,
              sourceSessionId: fork!.nativeId,
              forkSourceSessionId: record.nativeId,
            };
          case "queue-add": {
            if (
              host.work.filter((work) =>
                ["pending", "claimed", "dispatched", "unknown"].includes(work.status),
              ).length >= 100
            )
              throw new Error("queue-limit");
            const input = this.#resourceInput(
              record,
              value.input ?? value.text,
              value.resourceRefs,
            );
            validateClaudeContent(input);
            const item: ClaudeHostWork = {
              id: randomUUID(),
              requestId: randomUUID(),
              originRequestId: value.requestId,
              deviceId: value.deviceId,
              originDeviceId: value.deviceId,
              kind: "queue",
              status: "pending",
              input,
              requiresAttachments: Array.isArray(value.input),
              createdAt: new Date().toISOString(),
              report: null,
              usage: null,
            };
            if (
              Buffer.byteLength(JSON.stringify(host.work)) +
                Buffer.byteLength(JSON.stringify(item)) >
              64 * 1024 * 1024
            )
              throw new Error("queue-storage-limit");
            host.work.push(item);
            return {
              completed: false,
              queuedSubmission: {
                id: item.id,
                requestId: item.requestId,
                clientUserMessageId: item.originRequestId,
                status: item.status,
              },
            };
          }
          case "queue-update":
          case "queue-delete": {
            const item = host.work.find(
              (work) => work.id === value.queuedSubmissionId && work.kind === "queue",
            );
            if (!item || item.status !== "pending") throw new Error("queue-item-unavailable");
            if (item.originRequestId) host.settledRequests.push(item.originRequestId);
            if (operation === "queue-delete") {
              item.status = "cancelled";
              item.input = "";
              return {};
            }
            if (item.requiresAttachments || Array.isArray(item.input))
              throw new Error("queue-attachment-item-not-editable");
            if (typeof (value.input ?? value.text) !== "string")
              throw new Error("queue-update-requires-text");
            const input = this.#resourceInput(
              record,
              value.input ?? value.text,
              value.resourceRefs,
            );
            validateClaudeContent(input);
            item.input = input;
            item.originRequestId = value.requestId;
            if (Buffer.byteLength(JSON.stringify(host.work)) > 64 * 1024 * 1024)
              throw new Error("queue-storage-limit");
            return {
              completed: false,
              queuedSubmission: {
                id: item.id,
                requestId: item.requestId,
                clientUserMessageId: item.originRequestId,
                status: item.status,
              },
            };
          }
          case "queue-reorder": {
            const queue = host.work.filter(
              (work) => work.kind === "queue" && work.status === "pending",
            );
            const ids = value.queuedSubmissionIds;
            if (
              !Array.isArray(ids) ||
              ids.length !== queue.length ||
              new Set(ids).size !== ids.length ||
              queue.some((work) => !ids.includes(work.id))
            )
              throw new Error("stale-queue-order");
            const order = new Map(ids.map((itemId: string, index: number) => [itemId, index]));
            const ordered = [...queue].sort(
              (a, b) => Number(order.get(a.id)) - Number(order.get(b.id)),
            );
            let index = 0;
            host.work = host.work.map((work) =>
              work.kind === "queue" && work.status === "pending" ? ordered[index++]! : work,
            );
            return {};
          }
          case "queue-pause":
            host.paused = true;
            host.reason = "user-paused";
            return {};
          case "queue-resume":
          case "goal-resume": {
            if (value.handoffConfirmed !== true) throw new Error("handoff-confirmation-required");
            if (host.work.some((work) => work.status === "unknown" || work.status === "dispatched"))
              throw new Error("control-outcome-unconfirmed");
            host.paused = false;
            host.reason = null;
            if (operation === "goal-resume") {
              if (!host.goal || host.goal.status === "completed")
                throw new Error("goal-unavailable");
              if (host.goal.tokenBudget !== null && host.goal.usageIncomplete)
                throw new Error("usage-unavailable");
              if (host.goal.tokenBudget !== null && host.goal.tokensUsed >= host.goal.tokenBudget)
                throw new Error("token-budget-exhausted");
              host.goal.status = "active";
              host.goal.reason = null;
            }
            return {};
          }
          case "goal-set": {
            if (
              !isObject(value.goal) ||
              typeof value.goal.objective !== "string" ||
              !value.goal.objective.trim() ||
              Buffer.byteLength(value.goal.objective) > 16384
            )
              throw new Error("invalid-goal-objective");
            const intent = value.goal.intent ?? "start";
            if (intent !== "start" && intent !== "update") throw new Error("invalid-goal-intent");
            if (intent === "start" && host.goal) throw new Error("goal-already-exists");
            if (intent === "update" && !host.goal) throw new Error("goal-unavailable");
            const budget =
              intent === "update" && value.goal.tokenBudget === undefined
                ? host.goal!.tokenBudget
                : (value.goal.tokenBudget ?? null);
            if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0))
              throw new Error("invalid-goal-budget");
            for (const work of host.work)
              if (work.kind === "goal" && work.status === "pending") work.status = "cancelled";
            host.goal = {
              id: host.goal?.id ?? randomUUID(),
              generation: randomUUID(),
              objective: value.goal.objective,
              deviceId: intent === "update" ? host.goal!.deviceId : value.deviceId,
              tokenBudget: budget,
              tokensUsed: intent === "update" ? (host.goal?.tokensUsed ?? 0) : 0,
              elapsedMs: intent === "update" ? (host.goal?.elapsedMs ?? 0) : 0,
              usageIncomplete: intent === "update" ? (host.goal?.usageIncomplete ?? false) : false,
              missingUsageStepIds:
                intent === "update" ? [...(host.goal?.missingUsageStepIds ?? [])] : [],
              noProgressCount: intent === "update" ? (host.goal?.noProgressCount ?? 0) : 0,
              status: intent === "update" && host.goal?.status !== "active" ? "paused" : "active",
              reason: null,
              lastReport: intent === "update" ? (host.goal?.lastReport ?? null) : null,
            };
            if (host.goal.tokenBudget !== null && host.goal.usageIncomplete) {
              host.goal.status = "paused";
              host.goal.reason = "usage-unavailable";
            }
            if (intent === "start") {
              host.paused = false;
              host.reason = null;
            }
            return { goal: host.goal };
          }
          case "goal-pause":
            if (!host.goal) throw new Error("goal-unavailable");
            host.goal.status = "paused";
            host.goal.reason = "user-paused";
            return { goal: host.goal };
          case "goal-clear":
            if (!host.goal) throw new Error("goal-unavailable");
            host.goal = null;
            for (const work of host.work)
              if (work.kind === "goal" && work.status === "pending") work.status = "cancelled";
            return { goal: null };
          default:
            throw new Error("unsupported-Claude-managed-operation");
        }
      },
      externallyDispatched,
    );
    this.invalidateSchedulePermits(id);
    if (["goal-pause", "goal-clear", "archive"].includes(operation)) {
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
    }
    const currentLive = await this.#live(id, true);
    this.#publishConversationEvent?.(id, "state", currentLive, currentLive);
    return result;
  }

  async #scheduleList(id?: string): Promise<Record<string, unknown>> {
    for (const [permitId, permit] of this.#permits) {
      if (permit.expiresAt >= Date.now()) continue;
      this.#permits.delete(permitId);
      this.#hostState.releaseClaim(permit.sessionId, permit.item.id);
    }
    const records = id
      ? [this.#load(id)].filter((record): record is ClaudeRecord => !!record)
      : this.#listRecords();
    const sessions: Array<Record<string, unknown>> = [];
    for (const record of records) {
      if (record.released) continue;
      try {
        this.#validate(record);
        if (!this.#ownerLocks.has(record.id)) {
          const release = this.#tryLock(record.id);
          if (!release) continue;
          this.#ownerLocks.set(record.id, release);
        }
        const before = await this.#live(record.id, true);
        const next =
          before.status === "idle" && before.activity !== "compacting"
            ? this.#hostState.next(record.id)
            : null;
        const live = await this.#live(record.id, true);
        const host = this.#hostState.read(record.id);
        sessions.push({
          sessionId: record.id,
          workspaceId: record.workspaceId,
          runtimeBootId: this.bootId,
          revision: live.revision,
          scheduleRevision: host.revision,
          paused: host.paused,
          reason: host.reason,
          next: next
            ? {
                itemId: next.id,
                requestId: next.requestId,
                originRequestId: next.originRequestId,
                deviceId: next.deviceId,
                originDeviceId: next.originDeviceId,
                kind: next.kind,
                requiresAttachments: next.requiresAttachments,
                goalGeneration: next.goalGeneration,
              }
            : null,
        });
      } catch {
        /* Invalid or concurrently owned sessions are never scheduled. */
      }
    }
    return { sessions };
  }

  async #schedule(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof value.requestId !== "string" ||
      !uuidPattern.test(value.requestId) ||
      value.runtimeBootId !== this.bootId
    )
      throw new Error("invalid-schedule-request");
    const record = this.#load(id);
    if (!record || record.released) throw new Error("session-unavailable");
    this.#validate(record);
    if (!this.#ownerLocks.has(id)) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    if (value.operation === "schedule-pause") {
      this.invalidateSchedulePermits(id);
      const current = this.#hostState
        .read(id)
        .work.find((work) => work.status === "dispatched" && work.deviceId === value.deviceId);
      const running = this.#runners.get(id);
      if (
        current &&
        running &&
        running.snapshot().turnId === current.requestId &&
        running.snapshot().stopEnabled
      ) {
        try {
          await running.stop(current.requestId, running.snapshot().revision);
          this.#hostState.complete(id, current.requestId, {
            success: false,
            usage: null,
            cancelled: true,
          });
        } catch {
          this.#hostState.complete(id, current.requestId, {
            success: false,
            usage: null,
            unknown: true,
          });
        }
      }
      this.#hostState.pause(
        id,
        typeof value.reason === "string" ? value.reason.slice(0, 256) : "authorization-ended",
      );
      return {
        accepted: true,
        completed: true,
        sessionId: id,
        requestId: value.requestId,
        runtimeBootId: this.bootId,
      };
    }
    if (value.operation === "schedule-resume")
      return this.#hostControl(
        { ...value, operation: "queue-resume", experimentalEnabled: true },
        id,
      );
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
    const live = await this.#live(id, true);
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== live.revision)
      throw new Error("stale-Claude-revision");
    if (value.operation === "schedule-dispatch") {
      const permit = this.#permits.get(value.permitId);
      if (
        !permit ||
        permit.sessionId !== id ||
        permit.item.id !== value.itemId ||
        permit.item.requestId !== value.requestId ||
        permit.item.deviceId !== value.deviceId ||
        permit.expiresAt < Date.now() ||
        permit.revision !== value.expectedRevision
      )
        throw new Error("schedule-permit-unavailable");
      try {
        return await this.#control(
          {
            operation: "send",
            sessionId: id,
            requestId: value.requestId,
            deviceId: value.deviceId,
            runtimeBootId: this.bootId,
            expectedRevision: value.expectedRevision,
            experimentalEnabled: true,
            input: permit.item.input,
            schedulePermitId: value.permitId,
          },
          id,
        );
      } finally {
        this.#permits.delete(value.permitId);
        this.#hostState.releaseClaim(id, permit.item.id);
      }
    }
    if (live.status !== "idle" || live.activity === "compacting") throw new Error("session-busy");
    const prepareEpoch = this.#scheduleGeneration(id, value.deviceId);
    const item = this.#hostState.claim(id, value.itemId, value.deviceId);
    if (item.requestId !== value.requestId) {
      this.#hostState.releaseClaim(id, item.id);
      throw new Error("stale-schedule-item");
    }
    try {
      let options: { mcpConfig?: Record<string, unknown> } = {};
      if (item.kind === "goal") {
        const goal = this.#hostState.read(id).goal!;
        const old = this.#runners.get(id);
        if (old) {
          await old.shutdown();
          this.#runners.delete(id);
          this.#goalRunners.delete(id);
        }
        await this.#goalEndpoints.get(id)?.close();
        const endpoint = await createClaudeGoalReportEndpoint(
          {
            goalId: goal.id,
            goalGeneration: goal.generation,
            stepId: item.id,
            bootId: this.bootId,
          },
          (report) => this.#hostState.report(id, item.id, report),
        );
        this.#goalEndpoints.set(id, endpoint);
        options = { mcpConfig: endpoint.mcpConfig };
        item.input = `${goal.objective}\n\nContinue the authorized goal. Before finishing this step, call the AgentKib report_goal_step MCP tool for step ${item.id}. Report continue, complete, or blocked with evidence and remaining work. A normal text reply does not complete the goal.`;
      }
      await this.#prepareRunner(this.#load(id)!, options);
      const latest = await this.#live(id, true);
      if (
        prepareEpoch !== this.#scheduleGeneration(id, value.deviceId) ||
        this.#hostState.read(id).paused
      )
        throw new Error("schedule-paused");
      const permitId = randomUUID();
      const expiresAt = Date.now() + 15_000;
      this.#permits.set(permitId, {
        sessionId: id,
        item,
        expiresAt,
        revision: Number(latest.revision),
      });
      return {
        accepted: true,
        permitId,
        itemId: item.id,
        requestId: item.requestId,
        deviceId: item.deviceId,
        sessionId: id,
        runtimeBootId: this.bootId,
        expectedRevision: latest.revision,
        expiresAt,
      };
    } catch (error) {
      this.#hostState.releaseClaim(id, item.id);
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
      throw error;
    }
  }

  #resourceInput(record: ClaudeRecord, content: unknown, references: unknown): unknown {
    if (references === undefined || (Array.isArray(references) && references.length === 0))
      return content;
    if (!Array.isArray(references) || references.length > 32)
      throw new Error("invalid-resource-references");
    const pieces: string[] = [];
    for (const reference of references) {
      if (!isObject(reference) || !["file", "directory", "skill"].includes(reference.kind))
        throw new Error("unsupported-resource-reference");
      if (reference.kind === "skill") {
        const skill = this.#projectSkills(record).find((item) => item.id === reference.id);
        if (!skill) throw new Error("resource-skill-unavailable");
        pieces.push(`Use the project skill /${skill.id} for this request.`);
        continue;
      }
      const relative = reference.relativePath ?? reference.id;
      if (
        typeof relative !== "string" ||
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes("\\") ||
        relative.includes("\0") ||
        relative.split("/").includes("..")
      )
        throw new Error("invalid-resource-path");
      const target = path.join(record.workspace, relative);
      let current = record.workspace;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        if (lstatSync(current).isSymbolicLink()) throw new Error("resource-outside-workspace");
      }
      const resolved = canonicalize(target);
      const inside = path.relative(record.workspace, resolved);
      if (
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside) ||
        lstatSync(target).isSymbolicLink()
      )
        throw new Error("resource-outside-workspace");
      const info = lstatSync(resolved);
      if (reference.kind === "file") {
        if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
          throw new Error("resource-file-unavailable");
        const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const before = fstatSync(fd);
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > 64 * 1024 ||
            before.dev !== info.dev ||
            before.ino !== info.ino
          )
            throw new Error("resource-file-changed");
          const bytes = Buffer.alloc(before.size + 1);
          const size = readSync(fd, bytes, 0, bytes.length, 0);
          const after = fstatSync(fd);
          if (
            size !== before.size ||
            after.nlink !== 1 ||
            after.mtimeMs !== before.mtimeMs ||
            after.size !== before.size ||
            canonicalize(target) !== resolved
          )
            throw new Error("resource-file-changed");
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
        } finally {
          closeSync(fd);
        }
        if (text.includes("\0")) throw new Error("resource-file-unavailable");
        pieces.push(`Referenced file ${relative}:\n${text}`);
      } else {
        if (!info.isDirectory()) throw new Error("resource-directory-unavailable");
        pieces.push(
          `Referenced directory ${relative}:\n${readdirSync(resolved).slice(0, 100).join("\n")}`,
        );
      }
    }
    const context = pieces.join("\n\n");
    if (typeof content === "string") return `${content}\n\n${context}`;
    if (Array.isArray(content)) return [...content, { type: "text", text: context }];
    return context;
  }

  async #resources(id: string): Promise<Record<string, unknown>> {
    await this.context(id);
    const live = await this.#live(id, false);
    const record = this.#load(id);
    return {
      available: true,
      revision: live.revision,
      executionMode: "claude-managed",
      skills: record ? this.#projectSkills(record) : [],
      plugins: [],
      apps: [],
      // The host enumerates files through ArtifactService, which owns remote path
      // grants, sensitive-path filtering, identity checks and revision-bound IDs.
      contextReferences: [],
    };
  }

  #projectSkills(
    record: ClaudeRecord,
  ): Array<{ id: string; name: string; description?: string; available: true }> {
    return (this.#runners.get(record.id)?.optionsSnapshot.commands ?? []).flatMap((command) => {
      if (!/^[A-Za-z0-9_-]+$/.test(command.name)) return [];
      const file = path.join(record.workspace, ".claude", "skills", command.name, "SKILL.md");
      try {
        const resolved = canonicalize(file);
        const relative = path.relative(record.workspace, resolved);
        if (
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          lstatSync(file).isSymbolicLink() ||
          !lstatSync(resolved).isFile()
        )
          return [];
        return [
          {
            id: command.name,
            name: command.name,
            description: command.description,
            available: true as const,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  async #create(value: Record<string, any>): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "workspaceId",
      "requestId",
      "deviceId",
      "name",
      "model",
      "effort",
      "permissionMode",
    ]);
    const requestId = value.requestId;
    const workspaceId = value.workspaceId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.name !== undefined &&
        (typeof value.name !== "string" || Buffer.byteLength(value.name) > 512))
    )
      throw new Error("invalid-managed-create");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    const selectedSettings = this.#settings(value);
    if (
      Object.keys(selectedSettings).length &&
      !supportsClaudeVersion(this.#version?.value ?? "", "2.1.286")
    )
      throw new Error("unsupported-Claude-version");
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    const id = randomUUID();
    const nativeId = randomUUID();
    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      const evidence = {
        operation: "create",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      dispatchManagedCommand(this.dataDir, requestId);
      const now = new Date().toISOString();
      const name =
        typeof value.name === "string" && value.name.trim().length > 0 ? value.name : "Claude Code";
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: workspace,
        home: this.#home(),
        nativeId,
        title: Buffer.byteLength(name) <= 512 ? name : "Claude Code",
        createdAt: now,
        adopted: false,
        released: false,
        fresh: true,
        fingerprint: null,
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
        completedRequests: [],
      };
      this.#save(record);
      if (Object.keys(selectedSettings).length)
        this.#hostState.update(id, (host) => {
          host.settings = selectedSettings;
        });
      const live = {
        ...record.snapshot,
        revision: Number(record.snapshot.revision ?? 0) + this.#hostState.read(id).revision,
        sessionId: id,
        workspaceId,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        cliVersion: await this.#installationVersion(),
        permissionMode: "cli-configured",
      };
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: id,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        live,
      };
      finishManagedCommand(this.dataDir, requestId, result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
  }

  #compactingResult(id: string, requestId: string): Record<string, unknown> {
    return {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId,
      sessionId: id,
      runtimeBootId: this.bootId,
      error: "session-compacting",
      reason: "session-compacting",
    };
  }

  async #adopt(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "handoffConfirmed",
      "handoffFingerprint",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      value.handoffConfirmed !== true ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof value.handoffFingerprint !== "string" ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-adopt");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      const existing = this.#load(id);
      if (existing?.snapshot.activity === "compacting") throw new Error("session-compacting");
      if (managedSessionHasUnknownCommands(this.dataDir, id))
        throw new Error("control-outcome-unconfirmed");
      let workspaceId: string;
      let workspace: string;
      let nativeId: string;
      let handoff: string | null;
      let fresh: boolean;
      if (existing && existing.fresh && existing.released) {
        this.#validate(existing);
        if (value.handoffFingerprint !== this.#emptyFingerprint(existing))
          throw new Error("handoff-fingerprint-changed");
        ({ workspaceId, workspace, nativeId } = existing);
        handoff = null;
        fresh = true;
      } else {
        if (existing && !existing.released) throw new Error("session-already-managed");
        const target = await this.#resolveNative(id);
        this.#ensureNoExternalOwner(target.nativeId);
        const current = this.#targetFingerprint(target.nativeId, target.workspace);
        if (value.handoffFingerprint !== current) throw new Error("handoff-fingerprint-changed");
        workspaceId = target.workspaceId;
        workspace = target.workspace;
        nativeId = target.nativeId;
        handoff = current;
        fresh = false;
      }

      const evidence = {
        operation: "adopt",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      const previous = this.#load(id);
      const name = "Claude Code";
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: canonicalize(this.store.workspacePath(workspaceId)),
        home: this.#home(),
        nativeId,
        title: name,
        createdAt: new Date().toISOString(),
        adopted: previous?.adopted ?? true,
        released: false,
        fresh,
        fingerprint: handoff,
        ...(existing?.forkSourceNativeId
          ? { forkSourceNativeId: existing.forkSourceNativeId, forkCutoff: existing.forkCutoff }
          : {}),
        completedRequests: previous?.completedRequests ?? [],
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
      };
      if (this.#load(id)?.snapshot.activity === "compacting") throw new Error("session-compacting");
      dispatchManagedCommand(this.dataDir, requestId);
      this.#save(record);
      const live = {
        ...record.snapshot,
        sessionId: id,
        workspaceId,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        cliVersion: await this.#installationVersion(),
        permissionMode: "cli-configured",
      };
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: id,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        live,
      };
      finishManagedCommand(this.dataDir, requestId, result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
  }

  async #release(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof value.runtimeBootId !== "string" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-release");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    this.#privateDirectory(false);
    const ownerRelease = this.#ownerLocks.get(id);
    const releaseLock = ownerRelease ? null : this.#tryLock(id);
    if (!ownerRelease && !releaseLock) throw new Error("session-managed-by-another-runtime");
    let releasedOwned = false;
    try {
      const record = this.#load(id);
      if (!record) throw new Error("session-unavailable");
      this.#validate(record);
      if (record.released) throw new Error("session-released");
      const live = await this.#live(id, true);
      if (value.runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
      if (managedSessionHasUnknownCommands(this.dataDir, id) || live.status === "outcome-unknown")
        throw new Error("control-outcome-unconfirmed");
      if (live.activity === "compacting") return this.#compactingResult(id, requestId);
      if (Number(value.expectedRevision) !== live.revision)
        throw new Error("stale-Claude-revision");
      if (live.status !== "idle") throw new Error("session-busy");
      const evidence = {
        operation: "release",
        workspaceId: record.workspaceId,
        runtimeBootId: this.bootId,
        expectedRevision: value.expectedRevision,
        turnId: null,
        inputFingerprint: null,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) return claimed;
      dispatchManagedCommand(this.dataDir, requestId);
      const runner = this.#runners.get(id);
      if (runner) {
        await runner.shutdown();
        this.#runners.delete(id);
      }
      this.invalidateSchedulePermits(id);
      this.#hostState.pause(id, "released");
      record.released = true;
      this.#save(record);
      releasedOwned = true;
      const result = {
        accepted: true,
        completed: true,
        requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        controlOutcome: "accepted",
      };
      finishManagedCommand(this.dataDir, requestId, result);
      return result;
    } finally {
      if (releaseLock) releaseLock();
      if (ownerRelease && releasedOwned) {
        this.#ownerLocks.delete(id);
        ownerRelease();
      }
    }
  }

  #emptyFingerprint(record: ClaudeRecord): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.id,
          record.nativeId,
          record.workspace,
          record.home,
          record.fresh,
          record.released,
          ...(record.forkSourceNativeId ? [record.forkSourceNativeId, record.forkCutoff] : []),
        ]),
      )
      .digest("hex");
  }

  #targetFingerprint(nativeId: string, workspace: string): string {
    const transcript = this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
    const read = () => {
      const info = lstatSync(transcript);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024)
        throw new Error("invalid-Claude-transcript");
      const fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 128n * 1024n * 1024n)
          throw new Error("invalid-Claude-transcript");
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const size = readSync(fd, buffer, 0, buffer.length, null);
          if (size === 0) break;
          total += size;
          if (total > 128 * 1024 * 1024)
            throw new Error("Claude transcript exceeds handoff budget");
          chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        const after = fstatSync(fd, { bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          BigInt(total) !== before.size
        )
          throw new Error("Claude history changed during handoff");
        return Buffer.concat(chunks, total);
      } finally {
        closeSync(fd);
      }
    };
    const first = read();
    if (this.sessions.verifiedClaudeControlTarget(nativeId, workspace) !== transcript)
      throw new Error("Claude transcript target changed during handoff");
    const serialized = Buffer.from(
      JSON.stringify([nativeId.toLowerCase(), canonicalize(workspace)]),
    );
    return createHash("sha256").update(serialized).update(first).digest("hex");
  }

  #ensureNoExternalOwner(nativeId: string, ownedPid: number | null = null): void {
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    const output = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const mentioned = output.split("\n").some((line) => {
      const words = line.trim().split(/\s+/);
      if (ownedPid !== null && words[0] === String(ownedPid)) return false;
      return (
        words.some((word) => path.posix.basename(word) === "claude") &&
        (words.some(
          (word) => word === `--resume=${nativeId}` || word === `--session-id=${nativeId}`,
        ) ||
          words.some(
            (word, index) =>
              ["--resume", "-r", "--session-id"].includes(word) && words[index + 1] === nativeId,
          ))
      );
    });
    if (mentioned) throw new Error("Claude session is active in an external process");
  }

  async #reconcile(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const requestId = value.requestId;
    const allowed = new Set(["operation", "sessionId", "requestId", "deviceId"]);
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-reconcile");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
    const record = this.#load(id);
    if (!record || record.released || !this.#validateForReconcile(record))
      throw new Error("session-unavailable");
    const live = await this.#live(id, false);
    const evidence = {
      operation: "reconcile",
      workspaceId: record.workspaceId,
      executionMode: "claude-managed",
      runtimeBootId: this.bootId,
    };
    const claimed = claimManagedCommand(
      this.dataDir,
      requestId,
      id,
      fingerprint,
      value.deviceId,
      evidence,
    );
    if (claimed) return claimed;
    const result = {
      accepted: true,
      completed: true,
      requestId,
      sessionId: id,
      runtimeBootId: this.bootId,
      controlOutcome: "accepted",
      reconciled: live.status === "idle",
      live,
    };
    finishManagedCommand(this.dataDir, requestId, result);
    return result;
  }

  #validateForReconcile(record: ClaudeRecord): boolean {
    try {
      this.#validate(record);
      return true;
    } catch {
      return false;
    }
  }

  async #reserveRunner(id: string): Promise<boolean> {
    let release!: () => void;
    const previous = this.#runnerReservationTail;
    this.#runnerReservationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const existing = this.#runners.get(id);
      const needsSlot = !existing?.hasWorker || existing.isRetiring;
      if (needsSlot) {
        if (this.#runnerReservations.has(id)) return false;
        this.#runnerReservations.add(id);
      }
      const retirements: Array<[string, ClaudeManagedRunnerProcess, Promise<boolean>]> = [];
      for (const [otherId, runner] of this.#runners) {
        if (otherId === id) continue;
        const retirement = runner.retireIfInactive();
        if (retirement) retirements.push([otherId, runner, retirement]);
      }
      const retired = await Promise.allSettled(retirements.map(([, , retirement]) => retirement));
      for (const [index, [otherId, runner]] of retirements.entries()) {
        if (retired[index]?.status !== "fulfilled" || !retired[index].value) continue;
        const record = this.#load(otherId);
        if (record) {
          record.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(record);
        }
      }
      const retirementFailure = retired.find(
        (result) =>
          result.status === "rejected" || (result.status === "fulfilled" && !result.value),
      );
      if (retirementFailure?.status === "rejected") throw retirementFailure.reason;
      if (retirementFailure) throw new Error("Claude-runner-limit");
      const active =
        this.#runnerReservations.size +
        [...this.#runners.values()].filter((runner) => runner.hasWorker && !runner.isRetiring)
          .length;
      if (active > 8) throw new Error("Claude-runner-limit");
      return needsSlot;
    } catch (error) {
      this.#runnerReservations.delete(id);
      throw error;
    } finally {
      release();
    }
  }

  #tryLock(id: string): (() => void) | null {
    if (!supportsClaudeManagedRunner()) return null;
    this.#privateDirectory(false);
    const file = this.#path(id).replace(/\.json$/, ".lock");
    try {
      return acquirePortableFileLease(file);
    } catch (error) {
      if (error instanceof Error && error.message === "session-managed-by-another-runtime")
        return null;
      throw error;
    }
  }

  catalog(): Array<Record<string, unknown>> {
    const records = this.#listRecords();
    return records.flatMap((record) => {
      try {
        this.#validate(record);
        if (record.released && record.adopted) return [];
        const indexedSessionId = this.store.sessions.id("claude-code", record.nativeId);
        return [
          {
            id: record.id,
            indexedSessionId,
            workspace_id: record.workspaceId,
            agent: "claude-code",
            title: this.#hostState.peek(record.id)?.title ?? record.title,
            origin: "interactive",
            created_at: record.createdAt,
            updated_at: record.createdAt,
            message_count: null,
            git_branch: null,
            archived: this.#hostState.peek(record.id)?.archived ?? false,
            sidechain: false,
            availability: "readable",
            executionMode: "claude-managed",
            sourceSessionId: record.nativeId,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  hasManagedSession(id: string): boolean {
    return sessionIdPattern.test(id) && this.#load(id) !== null;
  }

  indexedAliases(): Set<string> {
    return new Set(
      this.catalog().flatMap((record) =>
        typeof record.indexedSessionId === "string" ? [record.indexedSessionId] : [],
      ),
    );
  }

  #directory(): string {
    return path.join(this.dataDir, "claude-managed");
  }

  #path(id: string): string {
    if (!sessionIdPattern.test(id)) throw new Error("invalid-session");
    return path.join(this.#directory(), `${id}.json`);
  }

  #home(): string {
    const configured =
      this.environment.CLAUDE_CONFIG_DIR ??
      path.join(this.environment.HOME ?? homedir(), ".claude");
    if (existsSync(configured)) return canonicalize(configured);
    const parent = path.dirname(configured);
    return path.join(canonicalize(parent), path.basename(configured));
  }

  #privateDirectory(create: boolean): void {
    const directory = this.#directory();
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    for (let current = directory; ; current = path.dirname(current)) {
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error("Claude metadata path is a symlink");
      }
      if (path.dirname(current) === current) break;
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Claude metadata directory unavailable");
    restrictRemotePath(directory, true);
  }

  #load(id: string): ClaudeRecord | null {
    const file = this.#path(id);
    if (!existsSync(file)) return null;
    this.#privateDirectory(false);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT)
      throw new Error("invalid-Claude-metadata");
    restrictRemotePath(file);
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.id !== id ||
      typeof value.workspaceId !== "string" ||
      typeof value.workspace !== "string" ||
      typeof value.home !== "string" ||
      typeof value.nativeId !== "string" ||
      !uuidPattern.test(value.nativeId) ||
      ((value.forkSourceNativeId !== undefined || value.forkCutoff !== undefined) &&
        (typeof value.forkSourceNativeId !== "string" ||
          !uuidPattern.test(value.forkSourceNativeId) ||
          value.forkSourceNativeId === value.nativeId ||
          typeof value.forkCutoff !== "string" ||
          !uuidPattern.test(value.forkCutoff))) ||
      typeof value.title !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.adopted !== "boolean" ||
      typeof value.released !== "boolean" ||
      typeof value.fresh !== "boolean" ||
      !isObject(value.snapshot) ||
      !Array.isArray(value.completedRequests)
    )
      throw new Error("invalid-Claude-metadata");
    return value as ClaudeRecord;
  }

  #save(record: ClaudeRecord): void {
    this.#privateDirectory(true);
    const target = this.#path(record.id);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid-Claude-metadata");
    }
    const temporary = path.join(this.#directory(), `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, target);
      const directoryFd = openSync(this.#directory(), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  #listRecords(): ClaudeRecord[] {
    const directory = this.#directory();
    if (!existsSync(directory)) return [];
    this.#privateDirectory(false);
    const entries = readdirSync(directory, { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    if (entries.length > 20_000) throw new Error("Claude managed catalog exceeds limit");
    return entries.flatMap((entry) => {
      if (!entry.name.endsWith(".json") || entry.isSymbolicLink() || !entry.isFile()) return [];
      const record = this.#load(path.basename(entry.name, ".json"));
      return record ? [record] : [];
    });
  }

  #validate(record: ClaudeRecord): void {
    const root = canonicalize(this.store.workspacePath(record.workspaceId));
    const expected = record.registeredWorkspace ?? record.workspace;
    if (pathIdentity(root) !== pathIdentity(canonicalize(expected)))
      throw new Error("session-workspace-mismatch");
    const actual = pathIdentity(canonicalize(record.workspace));
    const registered = pathIdentity(root);
    const relative = path.relative(registered, actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("session-workspace-mismatch");
    if (pathIdentity(this.#home()) !== pathIdentity(canonicalize(record.home)))
      throw new Error("claude-home-changed");
  }

  async #installationVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000) return this.#version.value;
    const executable = resolveCommand("claude", this.environment);
    if (!executable) {
      this.#version = { at: Date.now(), value: null };
      return null;
    }
    try {
      const output = await this.commands.run(executable, ["--version"], {
        env: this.environment,
        timeout: 5000,
        limit: 4096,
        strictOutput: true,
        allowFailure: true,
      });
      const version = output.bytes.toString("utf8").trim();
      const value = output.success && supportsClaudeVersion(version) ? version : null;
      this.#version = { at: Date.now(), value };
      return value;
    } catch {
      this.#version = { at: Date.now(), value: null };
      return null;
    }
  }

  async options(): Promise<Record<string, unknown>> {
    const cliVersion = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    const available = cliVersion !== null;
    return {
      available,
      ...(available ? {} : { reason: "unverified-installation" }),
      workspaces: available
        ? (this.store.listWorkspaces() as Array<Record<string, unknown>>).map(({ id, name }) => ({
            id,
            name,
          }))
        : [],
      models: [],
      permissionModes: supportsClaudeVersion(cliVersion ?? "", "2.1.286")
        ? ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id }))
        : [],
      cliVersion,
      permissionMode: "cli-configured",
    };
  }

  async #live(id: string, controls: boolean): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const version = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    if (!record) {
      await this.#resolveNative(id);
      return {
        sessionId: id,
        runtimeBootId: this.bootId,
        executionMode: "managed-resume",
        status: "idle",
        revision: 0,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason: "handoff-required",
        cliVersion: version,
        permissionMode: "cli-configured",
      };
    }
    this.#validate(record);
    this.#recoverCompletions(record);
    const runner = this.#runners.get(id);
    if (runner) {
      const snapshot = runner.snapshot();
      const turnId = snapshot.turnId;
      if (
        snapshot.status === "idle" &&
        typeof turnId === "string" &&
        turnId.length > 0 &&
        !record.completedRequests.includes(turnId)
      ) {
        try {
          record.fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
        } catch {
          // Completion is still recorded; a missing transcript cannot prove a new handoff.
        }
        record.completedRequests.push(turnId);
      }
      record.snapshot = snapshot as unknown as Record<string, unknown>;
      this.#save(record);
      this.#recoverCompletions(record);
    }
    let live: Record<string, unknown>;
    if (
      (!runner && record.snapshot.status !== "idle") ||
      managedSessionHasUnknownCommands(this.dataDir, id)
    ) {
      live = {
        ...record.snapshot,
        status: "outcome-unknown",
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason: "control-outcome-unconfirmed",
      };
    } else {
      live = { ...record.snapshot };
    }
    if (record.released) {
      live.status = "released";
      live.reason = "handoff-required";
    }
    live.sessionId = record.id;
    live.sourceSessionId = record.nativeId;
    live.workspaceId = record.workspaceId;
    live.runtimeBootId = this.bootId;
    live.executionMode = "claude-managed";
    live.permissionMode = "cli-configured";
    live.cliVersion = version;
    if (!runner?.hasWorker && isObject(live.usage))
      live.usage = projectContextUsage(
        {
          ...live.usage,
          // Persisted reports can belong to another backend process; only a resident runner
          // owns a generation in this runtime, including when its worker has retired.
          reportGeneration: runner ? live.usage.reportGeneration : undefined,
          state: "stale",
          reason: "connection-unavailable",
        },
        Number(live.revision),
      );
    if (!version) {
      live.sendEnabled = false;
      if (live.status === "idle") live.reason = "unverified-installation";
    }
    if (!controls || record.released) {
      live.sendEnabled = false;
      live.stopEnabled = false;
      for (const key of ["approvals", "questions"])
        if (Array.isArray(live[key]))
          live[key] = (live[key] as Array<Record<string, unknown>>).map((item) => ({
            ...item,
            supported: false,
          }));
    }
    const host = this.#hostState.read(id);
    live.revision = Number(live.revision ?? 0) + host.revision;
    live.goal = host.goal;
    live.archived = host.archived;
    live.schedule = { paused: host.paused, reason: host.reason, revision: host.revision };
    const options = runner?.optionsSnapshot;
    live.settings = {
      current: options?.settingsAcknowledged
        ? options.settings
        : { model: null, effort: null, permissionMode: null },
      selected: host.settings,
      applicationStatus: options?.settingsAcknowledged ? "confirmed" : "pending",
    };
    if (host.archived) {
      live.status = "archived";
      live.sendEnabled = false;
      live.stopEnabled = false;
    }
    return live;
  }

  #streamLive(
    id: string,
    snapshot: ClaudeRunnerSnapshot,
    record = this.#load(id),
  ): Record<string, unknown> {
    return {
      ...snapshot,
      revision: snapshot.revision + this.#hostState.read(id).revision,
      sessionId: id,
      sourceSessionId: record?.nativeId ?? null,
      workspaceId: record?.workspaceId ?? null,
      runtimeBootId: this.bootId,
      executionMode: "claude-managed",
      permissionMode: "cli-configured",
      cliVersion: this.#version?.value ?? null,
    };
  }

  async live(id: string, controls = false) {
    return this.#live(id, controls);
  }

  async receipt(value: unknown): Promise<unknown> {
    if (
      !isObject(value) ||
      value.found !== true ||
      value.executionMode !== "claude-managed" ||
      typeof value.sessionId !== "string" ||
      typeof value.requestId !== "string"
    )
      return value;
    const record = this.#load(value.sessionId);
    if (!record) return value;
    await this.request({ operation: "live", sessionId: value.sessionId });
    const current = this.#load(value.sessionId);
    const completionObserved = Boolean(
      current?.completedRequests.includes(value.requestId) ||
      (value.operation === "steer" &&
        value.status === "accepted" &&
        typeof value.turnId === "string" &&
        current?.completedRequests.includes(value.turnId)) ||
      this.#hostState.read(value.sessionId).settledRequests.includes(value.requestId),
    );
    const receipt: Record<string, any> = { ...value, completionObserved };
    if (typeof value.ack?.publicInputHash === "string")
      receipt.publicInputHash = value.ack.publicInputHash;
    if (completionObserved && value.operation === "send" && value.status === "unknown" && current) {
      receipt.ack = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: value.requestId,
        sessionId: current.id,
        sourceSessionId: current.nativeId,
        runtimeBootId: typeof value.runtimeBootId === "string" ? value.runtimeBootId : this.bootId,
        completionObserved: true,
      };
      receipt.status = "accepted";
    }
    return receipt;
  }

  #recoverCompletions(record: ClaudeRecord): void {
    if (record.completedRequests.length === 0) return;
    for (const command of readUnknownManagedCommands(this.dataDir, record.id)) {
      if (
        command.evidence?.operation !== "send" ||
        !record.completedRequests.includes(command.requestId)
      )
        continue;
      finishManagedCommand(this.dataDir, command.requestId, {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: command.requestId,
        sessionId: record.id,
        sourceSessionId: record.nativeId,
        runtimeBootId:
          typeof command.evidence.runtimeBootId === "string"
            ? command.evidence.runtimeBootId
            : this.bootId,
        completionObserved: true,
      });
    }
  }

  async capabilities(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    const version = supportsClaudeManagedRunner() && (await this.#installationVersion()) !== null;
    const owned = Boolean(record && !record.released);
    const host = owned ? this.#hostState.read(id) : null;
    const writable =
      version && controls && owned && !host?.archived && live.status !== "outcome-unknown";
    const idle = writable && live.status === "idle" && live.activity !== "compacting";
    const goalBudgetReason =
      host?.goal && host.goal.tokenBudget !== null
        ? host.goal.usageIncomplete
          ? "usage-unavailable"
          : host.goal.tokensUsed >= host.goal.tokenBudget
            ? "token-budget-exhausted"
            : null
        : null;
    const map: Record<string, boolean> = {
      send: writable && live.sendEnabled === true,
      stop: writable && live.stopEnabled === true,
      steer: writable && live.status === "running" && live.activity !== "compacting",
      approve: writable && Array.isArray(live.approvals) && live.approvals.length > 0,
      answer: writable && Array.isArray(live.questions) && live.questions.length > 0,
      attachments: writable && live.activity !== "compacting",
      files: true,
      adopt: !owned && version && controls,
      release: idle,
      inspect: true,
      reconcile: owned,
      usage: true,
      context: owned,
      resources: owned,
      settings: idle,
      "settings-state": owned,
      queue: writable,
      "queue-list": owned,
      "queue-add": writable,
      "queue-update": writable,
      "queue-delete": writable,
      "queue-reorder": writable,
      "queue-resume": idle && host?.paused === true,
      "queue-pause": writable && host?.paused !== true,
      fork: idle && record?.fresh === false,
      archive: idle,
      unarchive: version && controls && host?.archived === true,
      rename: idle,
      goal: owned,
      "goal-set": idle,
      "goal-pause": writable && host?.goal?.status === "active",
      "goal-resume":
        idle &&
        !!host?.goal &&
        !goalBudgetReason &&
        ["paused", "blocked", "budget-exhausted"].includes(host.goal.status),
      "goal-clear": writable && !!host?.goal,
    };
    if (!supportsClaudeVersion(this.#version?.value ?? "", "2.1.286")) {
      for (const feature of [
        "steer",
        "settings",
        "settings-state",
        "queue",
        "queue-list",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "queue-resume",
        "queue-pause",
        "fork",
        "rename",
        "archive",
        "unarchive",
        "goal",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "context",
        "resources",
      ])
        map[feature] = false;
    }
    return {
      sessionId: id,
      executionMode: live.executionMode,
      status: live.status,
      reason: live.reason,
      features: Object.fromEntries(
        Object.entries(map).map(([key, available]) => [
          key,
          available
            ? { available: true }
            : {
                available: false,
                reason:
                  key === "goal-resume" && goalBudgetReason
                    ? goalBudgetReason
                    : !version
                      ? "unverified-installation"
                      : !owned
                        ? "handoff-required"
                        : "operation-unavailable",
              },
        ]),
      ),
    };
  }

  async inspect(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    if (record?.fresh)
      return {
        sessionId: id,
        live,
        workspaceId: record.workspaceId,
        sourceSessionId: record.nativeId,
        handoffFingerprint: this.#emptyFingerprint(record),
        reconciled: false,
      };
    const target = await this.#resolveNative(id);
    return {
      sessionId: id,
      workspaceId: target.workspaceId,
      sourceSessionId: target.nativeId,
      handoffFingerprint: target.fingerprint,
      live,
      reconciled: false,
    };
  }

  async context(id: string): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const workspace = record
      ? (this.#validate(record), record.workspace)
      : (await this.#resolveNative(id)).workspace;
    return { available: true, cwd: workspace, projectId: null, branchAtCreation: null };
  }

  async events(id: string, cursor: unknown, limit: unknown): Promise<unknown> {
    const record = this.#load(id);
    if (record) {
      this.#validate(record);
      if (record.fresh) return { events: [], next_cursor: null, warnings: [] };
      const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
      return this.sessions.eventsForNative(
        "claude-code",
        record.nativeId,
        record.workspace,
        typeof cursor === "string" ? cursor : null,
        count,
      );
    }
    const target = await this.#resolveNative(id);
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
    return this.sessions.eventsForNative(
      "claude-code",
      target.nativeId,
      target.workspace,
      typeof cursor === "string" ? cursor : null,
      count,
    );
  }

  async settingsState(id: string): Promise<Record<string, unknown>> {
    let live = await this.#live(id, false);
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      return { available: false, reason: "unsupported-Claude-version", revision: live.revision };
    const record = this.#load(id);
    if (record && !record.released && live.status === "idle" && live.activity !== "compacting") {
      await this.#prepareRunner(record);
      live = await this.#live(id, false);
    }
    const state = this.#hostState.read(id);
    const native = this.#runners.get(id)?.optionsSnapshot;
    const selected = {
      model: state.settings.model ?? null,
      effort: state.settings.effort ?? null,
      permissionMode: state.settings.permissionMode ?? null,
    };
    const confirmed = native?.settingsAcknowledged === true;
    const current = confirmed
      ? native.settings
      : { model: null, effort: null, permissionMode: null };
    const mutable =
      this.#load(id)?.released === false &&
      live.status === "idle" &&
      live.activity !== "compacting" &&
      !state.archived;
    return {
      available: true,
      executionMode: "claude-managed",
      revision: live.revision,
      tokenUsage: live.tokenUsage ?? null,
      current,
      selected,
      settings: selected,
      defaults: { model: null, effort: null, permissionMode: null },
      applicationStatus: confirmed ? "confirmed" : "pending",
      models: (native?.models ?? []).map((model) => ({
        id: model.value,
        ...(model.resolvedModel !== undefined ? { resolvedModel: model.resolvedModel } : {}),
        name: model.displayName,
        efforts: model.supportedEffortLevels ?? [],
      })),
      permissionModes: ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id })),
      writable: {
        model: { available: mutable && !!native?.models.length },
        effort: {
          available:
            mutable && !!native?.models.some((model) => model.supportedEffortLevels?.length),
        },
        permissionMode: { available: mutable },
        restoreDefaults: { available: mutable },
      },
      skills: [],
      plugins: [],
      apps: [],
      contextReferences: { supportedTypes: ["file", "directory", "skill"] },
    };
  }

  async #resolveNative(
    id: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const managed = this.#load(id);
    if (managed) {
      this.#validate(managed);
      if (managed.fresh)
        return {
          workspaceId: managed.workspaceId,
          workspace: managed.workspace,
          nativeId: managed.nativeId,
          fingerprint: this.#emptyFingerprint(managed),
        };
      return {
        workspaceId: managed.workspaceId,
        workspace: managed.workspace,
        nativeId: managed.nativeId,
        fingerprint: this.#targetFingerprint(managed.nativeId, managed.workspace),
      };
    }
    const session = this.store.sessions.get(id);
    if (!session) throw new Error("session-unavailable");
    if (session.agent !== "claude-code" || session.sidechain)
      throw new Error("session-not-controllable");
    const workspace = canonicalize(this.store.workspacePath(session.workspace_id));
    return this.#findNative(id, session.workspace_id, workspace);
  }

  async #findNative(
    id: string,
    workspaceId: string,
    workspace: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const listing = await this.sessions.list("claude-code", workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.sessions.id("claude-code", candidate.native_ref) === id,
    );
    if (!native) throw new Error("session-unavailable");
    const document = await this.sessions.document(id);
    if (
      document.source.agent !== "claude-code" ||
      document.source.workspace_id !== workspaceId ||
      native.sidechain
    )
      throw new Error("unverified-session-identity");
    const nativeWorkspace = this.sessions.claudeControlWorkspace(native.native_ref, workspace);
    const digest = this.#targetFingerprint(native.native_ref, nativeWorkspace);
    return {
      workspaceId,
      workspace: nativeWorkspace,
      nativeId: native.native_ref,
      fingerprint: digest,
    };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
