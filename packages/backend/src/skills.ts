import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { compareUtf8 } from "./workspaces";
import { SkillManager } from "./skill-manager";
import { copySkillPackage, skillPackage, skillPreviewFile } from "./skill-package";
import { commitTask, currentTask, isTaskCancellation } from "./task-executor";
import {
  SKILL_HASH_ALGORITHM,
  SkillStateStore,
  readSkillJson,
  writeSkillJson,
  withSkillLocks,
} from "./skill-state";
import {
  executeLibraryTransaction,
  listLibraryTransactions,
  readLibraryTransaction,
  recoverLibraryTransactions,
} from "./skill-library-transaction";
import { SkillSyncService } from "./skill-sync";

const MAX_TREE_ENTRIES = 20_000;
const MAX_CANDIDATES = 200;
const MAX_SKILL_FILES = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_STAGED_BYTES = 1024 * 1024 * 1024;
const PREVIEW_METADATA_FILE = ".agentkib-preview.json";
// Preparation and application may outlive a preview's TTL, including across
// Skills instances sharing the same Home in this process.
const activePreviewDirectories = new Set<string>();
const CURATED = "https://github.com/openai/skills/tree/main/skills/.curated";

function portableSkillPath(value: string): string {
  const parts = value.split("/");
  for (const part of parts) {
    const stem = part.split(".", 1)[0]?.trimEnd().toUpperCase();
    if (
      !part ||
      /[<>:"|?*]/.test(part) ||
      [...part].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      /[. ]$/.test(part) ||
      [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
        ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
      ].includes(stem ?? "")
    )
      throw new Error(`Skill package contains a non-portable path: ${value}`);
  }
  return parts.map((part) => part.normalize("NFC").toLowerCase()).join("/");
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  let failure: { reason: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failure && cursor < items.length) {
        const index = cursor++;
        try {
          output[index] = await mapper(items[index]!);
        } catch (reason) {
          failure ??= { reason };
        }
      }
    }),
  );
  // Callers can clean up only after in-flight mappers have stopped writing.
  if (failure) throw failure.reason;
  return output;
}

type Source = {
  kind: "openai-curated" | "github";
  repository: string;
  ref: string;
  path: string;
  resolved_commit: string;
  tree_sha: string;
  ref_type?: "tag" | "branch" | "commit";
};
type VersionSelector = { type: "tag" | "branch" | "commit"; value: string };
type Candidate = {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  source: Source;
};
type FileEntry = { path: string; size: number; executable: boolean };
type LockEntry = {
  source: Source | null;
  content_sha256: string;
  installed_at: string;
  updated_at: string;
  display_name?: string;
  local_source?: string | null;
  local_resolved_path?: string | null;
  upstream_base_hash?: string | null;
  upstream_display_name?: string;
  snapshot_hash?: string;
  hash_algorithm?: typeof SKILL_HASH_ALGORITHM;
  version_origin?: {
    kind: "github" | "local-import" | "deployment" | "library-edit";
    deployment_id?: string;
    operation_id: string;
  };
  library_instance_id?: string;
};
type LockFile = {
  schema_version: number;
  skills: Record<string, LockEntry>;
  previous: Record<string, LockEntry>;
};
type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type Prepared = {
  preview: Record<string, unknown>;
  name: string;
  packagePath: string;
  tempPath: string;
  lock: LockEntry;
  expectedHash: string | null;
  expectedLock: string;
  beforePath: string | null;
  stagedBytes: number;
  operationId?: string;
  beforeCommit?: () => Promise<void>;
};
type ImportItem = {
  id: string;
  observation_ids: string[];
  paths: string[];
  agents: string[];
  resolved_path: string | null;
  library_id: string | null;
  display_name: string;
  status: "ready" | "skipped" | "failed";
  reason?: string;
  preview?: Record<string, unknown>;
};
type ImportBatch = {
  token: string;
  expires_at: string;
  total_size: number;
  items: ImportItem[];
  prepared: Map<string, Prepared>;
  skipped: Map<string, { name: string; expectedHash: string; expectedLock: string }>;
};
type Installed = Awaited<ReturnType<Skills["installed"]>>[number] & { warnings?: string[] };
type ImportReport = {
  token: string;
  items: Array<{
    id: string;
    observation_ids: string[];
    status: "imported" | "skipped" | "failed";
    library_id?: string;
    skill?: Installed;
    error?: string;
    warnings?: string[];
  }>;
  warnings?: string[];
};
type Observation = Awaited<ReturnType<SkillManager["inventory"]>>["observations"][number];
type SkillMetadata = {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
};

function skillRoot(environment: NodeJS.ProcessEnv) {
  const custom = environment.AGENTKIB_HOME;
  if (custom) {
    if (!path.isAbsolute(custom)) throw new Error("AGENTKIB_HOME must be an absolute path");
    return custom;
  }
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  return path.join(
    home,
    environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
  );
}

export class Skills {
  readonly root: string;
  readonly cache: string;
  #previews = new Map<string, Prepared>();
  #imports = new Map<string, ImportBatch>();
  #importResults = new Map<string, ImportReport>();
  #previewRetention: Promise<void> = Promise.resolve();
  #busy = false;
  readonly manager: SkillManager;
  readonly state: SkillStateStore;
  readonly sync: SkillSyncService;

  constructor(
    environment: NodeJS.ProcessEnv,
    dataDir: string,
    listWorkspaces: () => unknown[] = () => [],
  ) {
    this.root = skillRoot(environment);
    this.cache = path.join(dataDir, "skill-cache");
    this.state = new SkillStateStore(this.root);
    this.manager = new SkillManager(this.root, environment, listWorkspaces);
    this.sync = new SkillSyncService(this.root, this.manager, {
      list: async () => {
        const lock = await this.#lock();
        const entries = await Promise.all(
          Object.keys(lock.skills).map((id) => this.#syncLibrary(id)),
        );
        return entries.filter((entry) => entry !== null);
      },
      get: (id) => this.#syncLibrary(id),
      accept: (input) => this.#syncAccept(input),
      fork: (input) => this.#syncFork(input),
      check: (id) => this.#syncCheck(id),
      update: (id, operationId, beforeCommit) => this.#syncUpdate(id, operationId, beforeCommit),
      operationStatus: async (id) => {
        const journal = await readLibraryTransaction(this.root, id);
        return journal
          ? { library_id: journal.library_id, committed: journal.state === "committed" }
          : null;
      },
      transactions: async () =>
        (await listLibraryTransactions(this.root)).map((journal) => ({
          operation_id: journal.id,
          library_id: journal.library_id,
          operation: journal.operation,
          status: journal.state,
          started_at: journal.created_at,
          ...(journal.error ? { error: journal.error } : {}),
        })),
      recover: (id) => withSkillLocks([this.root], () => recoverLibraryTransactions(this.root, id)),
    });
  }

  async request(method: string, params: Record<string, unknown>) {
    currentTask()?.checkpoint();
    return this.#request(method, params);
  }

  async #request(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "skills.listCatalog":
        return this.catalog(params.force === true);
      case "skills.discover":
        return this.discover(this.#string(params.url, "url"));
      case "skills.listInstalled":
        return this.installed();
      case "skills.prepareInstall":
        return this.prepareInstall(params.source as Source);
      case "skills.applyOperation":
        return this.#lifecycle(() => this.apply(params));
      case "skills.checkUpdates":
        return this.checkUpdates();
      case "skills.prepareUpdate":
        return this.prepareUpdate(this.#string(params.name, "name"));
      case "skills.listVersions":
        return this.listVersions(params);
      case "skills.prepareVersionChange":
        return this.prepareVersionChange(params);
      case "skills.rollback":
        return this.#lifecycle(() => this.rollback(params));
      case "skills.uninstall":
        return this.#lifecycle(() => this.uninstall(params));
      case "skills.listRemoved":
        return this.removed();
      case "skills.restore":
        return this.#lifecycle(() => this.restore(params));
      case "skills.readFile":
        return this.readFile(params);
      case "skills.inventory":
        return this.manager.inventory();
      case "skills.targets":
        return this.manager.targets();
      case "skills.getDetail":
        return this.manager.detail(params);
      case "skills.readDetailFile":
        return this.manager.readDetailFile(params);
      case "skills.prepareImport":
        return this.prepareImport(this.#string(params.observation_id, "observation_id"));
      case "skills.prepareImports":
        return this.#lifecycle(() => this.prepareImports(params));
      case "skills.applyImports":
        return this.#lifecycle(() => this.applyImports(params));
      case "skills.discardPreview":
        if (typeof params.token === "string" && this.sync.hasPreview(params.token))
          return this.sync.discardPreview(params.token);
        return this.#lifecycle(() => this.discardPreview(this.#string(params.token, "token")));
      case "skills.readPreviewFile":
        if (typeof params.token === "string" && this.sync.hasPreview(params.token))
          return this.sync.readPreviewFile(params);
        if (params.comparison !== undefined)
          throw new Error("Baseline comparisons require a Skill synchronization preview");
        if (params.target_id !== undefined && params.item_id !== undefined)
          throw new Error("Choose exactly one preview target or import item");
        return params.target_id === undefined
          ? this.readPreviewFile(params)
          : this.manager.readPreviewFile(params);
      case "skills.listDeployments":
        return this.manager.listDeployments();
      case "skills.prepareDeployment":
        return this.manager.prepareDeployment(params);
      case "skills.applyDeployment":
        return this.#lifecycle(async () => {
          const recoveryTarget =
            typeof params.token === "string"
              ? await this.sync.recoveryTargetId(params.token)
              : null;
          if (recoveryTarget) {
            const report = await this.sync.recover({
              operation_id: params.token,
              confirmed: params.confirmed,
              approve_home: params.approve_home,
            });
            return {
              ...report,
              results: report.results.map((row) => ({
                ...row,
                target_id: recoveryTarget,
                deployment_id: row.deployment_id ?? null,
                path: row.path ?? "",
                error: row.error ?? null,
              })),
            };
          }
          const result = await this.manager.applyDeployment(params);
          return result;
        });
      case "skills.syncState":
      case "skills.prepareSync":
      case "skills.applySync":
      case "skills.syncPolicy":
      case "skills.saveSyncPolicy":
      case "skills.syncRuns":
      case "skills.recoverSync":
      case "skills.runDueSync":
        return this.sync.request(method, params);
      default:
        throw new Error(`Unknown Skill method: ${method}`);
    }
  }

  async catalog(force: boolean) {
    const file = path.join(this.cache, "curated-skills.json");
    if (!force) {
      const cached = (await this.#readJson(file).catch(() => null)) as {
        cached_at?: string;
        entries?: Array<{ candidate: Candidate; installed?: boolean }>;
        stale?: boolean;
      } | null;
      if (cached?.cached_at && Date.now() - Date.parse(cached.cached_at) < 6 * 60 * 60_000)
        return this.#annotate(cached);
    }
    try {
      const entries = await this.discover(CURATED);
      const snapshot = {
        entries: entries.map((candidate) => ({ candidate, installed: false })),
        cached_at: new Date().toISOString(),
        stale: false,
      };
      await this.#writeJson(file, snapshot);
      return this.#annotate(snapshot);
    } catch (error) {
      if (
        currentTask()?.signal.aborted &&
        currentTask()?.signal.reason?.reason === "backend-closing"
      )
        throw error;
      const cached = (await this.#readJson(file).catch(() => null)) as {
        cached_at?: string;
        entries?: Array<{ candidate: Candidate; installed?: boolean }>;
        stale?: boolean;
      } | null;
      if (!cached) throw error;
      // A deadline fallback must not restart directory hashing after its budget expired.
      if (currentTask()?.signal.aborted)
        return {
          entries: (cached.entries ?? []).map((entry) => ({
            ...entry.candidate,
            installed: entry.installed === true,
          })),
          cached_at: cached.cached_at ?? new Date().toISOString(),
          stale: true,
        };
      return this.#annotate({ ...cached, stale: true });
    }
  }

  async #lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("Skill lifecycle is busy");
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  async #syncLibrary(id: string) {
    this.#validateId(id);
    const record = (await this.#lock()).skills[id];
    if (!record) return null;
    const directory = path.join(this.root, "skills", id);
    const diagnostics: string[] = [];
    let observed: string | null = null;
    try {
      observed = await this.#targetHash(directory);
      if (!observed) diagnostics.push("Skill package is missing");
      else
        this.#frontmatter(
          await fs.readFile(path.join(directory, "SKILL.md"), "utf8"),
          record.display_name ?? id,
        );
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
    return {
      id,
      instance_id: record.library_instance_id ?? record.installed_at,
      display_name: record.display_name ?? id,
      hash: record.content_sha256,
      observed_hash: observed,
      lock_fingerprint: this.#lockFingerprint(record),
      source: record.source,
      upstream_base_hash:
        record.upstream_base_hash ?? (record.source ? record.content_sha256 : null),
      path: directory,
      valid: observed !== null && diagnostics.length === 0,
      diagnostics,
    };
  }

  async #syncAccept(input: {
    id: string;
    snapshotPath: string;
    expectedHash: string | null;
    expectedLock: string;
    operationId: string;
    originDeploymentId?: string;
    originKind?: "deployment" | "local-import" | "library-edit";
  }) {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      const completed = await readLibraryTransaction(this.root, input.operationId);
      if (completed?.state === "committed") {
        if (completed.library_id !== input.id) throw new Error("Skill operation identity changed");
        const result = await this.#syncLibrary(input.id);
        if (!result) throw new Error("Previously saved Skill is no longer present");
        return result;
      }
      this.#validateId(input.id);
      const lock = await this.#lock();
      const current = lock.skills[input.id];
      if (!current || this.#lockFingerprint(current) !== input.expectedLock)
        throw new Error("Skill library record changed after preview");
      const currentPath = path.join(this.root, "skills", input.id);
      if ((await this.#targetHash(currentPath)) !== input.expectedHash)
        throw new Error("Skill library contents changed after preview");
      const hash = await this.state.snapshot(input.snapshotPath);
      const snapshot = await this.state.verifySnapshot(hash);
      const tempPath = await this.#staging();
      const packagePath = path.join(tempPath, "package");
      try {
        await copySkillPackage(snapshot, packagePath);
        const metadata = this.#frontmatter(
          await fs.readFile(path.join(packagePath, "SKILL.md"), "utf8"),
          current.display_name ?? input.id,
        );
        const now = new Date().toISOString();
        await this.#applyPrepared({
          name: input.id,
          packagePath,
          tempPath,
          beforePath: null,
          stagedBytes: (await skillPackage(snapshot)).totalSize,
          expectedHash: input.expectedHash,
          expectedLock: input.expectedLock,
          operationId: input.operationId,
          preview: { operation: "reverse-sync" },
          lock: {
            ...current,
            content_sha256: hash,
            display_name: metadata.name,
            updated_at: now,
            upstream_base_hash:
              current.upstream_base_hash ?? (current.source ? current.content_sha256 : null),
            ...(current.source
              ? {
                  upstream_display_name:
                    current.upstream_display_name ?? current.display_name ?? input.id,
                }
              : {}),
            version_origin: {
              kind: input.originKind ?? "deployment",
              operation_id: input.operationId,
              ...(input.originDeploymentId ? { deployment_id: input.originDeploymentId } : {}),
            },
          },
        });
        return (await this.#syncLibrary(input.id))!;
      } finally {
        activePreviewDirectories.delete(tempPath);
        await fs.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async #syncFork(input: {
    snapshotPath: string;
    displayName: string;
    operationId: string;
    localSource?: string;
  }) {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      const completed = await readLibraryTransaction(this.root, input.operationId);
      if (completed?.state === "committed") {
        const result = await this.#syncLibrary(completed.library_id);
        if (!result) throw new Error("Previously imported Skill is no longer present");
        return result;
      }
      const hash = await this.state.snapshot(input.snapshotPath);
      const snapshot = await this.state.verifySnapshot(hash);
      const metadata = this.#frontmatter(
        await fs.readFile(path.join(snapshot, "SKILL.md"), "utf8"),
        input.displayName,
        true,
      );
      const lock = await this.#lock();
      const name = this.#allocateLocalName(
        metadata.name,
        input.operationId,
        await this.#reservedNames(lock),
      );
      const tempPath = await this.#staging();
      const packagePath = path.join(tempPath, "package");
      try {
        await copySkillPackage(snapshot, packagePath);
        const now = new Date().toISOString();
        await this.#applyPrepared({
          name,
          packagePath,
          tempPath,
          beforePath: null,
          stagedBytes: (await skillPackage(snapshot)).totalSize,
          expectedHash: null,
          expectedLock: this.#lockFingerprint(undefined),
          operationId: input.operationId,
          preview: { operation: "install" },
          lock: {
            source: null,
            content_sha256: hash,
            display_name: metadata.name,
            installed_at: now,
            updated_at: now,
            upstream_base_hash: null,
            local_source: input.localSource ?? null,
            version_origin: { kind: "local-import", operation_id: input.operationId },
          },
        });
        return (await this.#syncLibrary(name))!;
      } finally {
        activePreviewDirectories.delete(tempPath);
        await fs.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async #syncCheck(id: string) {
    const library = await this.#syncLibrary(id);
    if (!library?.source) return { available: false };
    const source = library.source;
    // Tags and commits remain pinned to their accepted commit in automatic mode.
    if (source.ref_type === "tag" || source.ref_type === "commit") return { available: false };
    const [owner, repository] = source.repository.split("/");
    const commit = await this.#commit(owner!, repository!, source.ref, source.ref_type);
    const resolved = await this.#resolve({
      owner: owner!,
      repository: repository!,
      reference: commit,
      selectorPath: source.path,
    });
    const tree =
      source.path === ""
        ? resolved.rootTree
        : resolved.entries.find((entry) => entry.type === "tree" && entry.path === source.path)
            ?.sha;
    if (!tree) throw new Error("GitHub Skill package no longer exists at the tracked path");
    return { available: tree !== source.tree_sha };
  }

  async #syncUpdate(id: string, operationId: string, beforeCommit?: () => Promise<void>) {
    const library = await this.#syncLibrary(id);
    if (!library?.source || !library.valid)
      throw new Error("Skill is not eligible for an automatic GitHub update");
    if (library.observed_hash !== library.hash || library.hash !== library.upstream_base_hash)
      throw new Error("Locally customized Skill requires an explicit upstream replacement");
    if (library.source.ref_type === "tag" || library.source.ref_type === "commit") return library;
    const preview = await this.prepareUpdate(id);
    const prepared = this.#previews.get(String(preview.token));
    if (!prepared) throw new Error("Skill update preview is missing");
    if (prepared.preview.local_modified)
      throw new Error("Skill changed during automatic update preparation");
    prepared.operationId = operationId;
    prepared.beforeCommit = beforeCommit;
    await this.apply({ token: preview.token, confirmed: true });
    return (await this.#syncLibrary(id))!;
  }

  async discover(input: string): Promise<Candidate[]> {
    const parsed = await this.#parseUrl(input);
    const selected = await this.#resolve(parsed);
    const candidates = selected.entries.filter((entry) => {
      if (entry.type !== "blob" || path.posix.basename(entry.path) !== "SKILL.md") return false;
      const directory = path.posix.dirname(entry.path);
      const relative = selected.selectorPath
        ? directory.slice(selected.selectorPath.length).replace(/^\//, "")
        : directory;
      return relative.split("/").filter(Boolean).length <= 8;
    });
    if (candidates.length > MAX_CANDIDATES)
      throw new Error("GitHub repository contains more than 200 Skill candidates");
    if (candidates.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > 8 * 1024 * 1024)
      throw new Error("Skill metadata exceeds the 8 MiB limit");
    const results = await mapConcurrent(candidates, 8, async (entry) => {
      const directory =
        path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path);
      try {
        const content = await this.#raw(
          selected.owner,
          selected.repository,
          selected.commit,
          entry.path,
          MAX_ENTRY_BYTES,
        );
        const metadata = this.#frontmatter(content.toString("utf8"));
        const tree = selected.entries.find(
          (value) => value.type === "tree" && value.path === directory,
        );
        const treeSha = tree?.sha ?? (directory === "" ? selected.rootTree : undefined);
        if (!treeSha) throw new Error(`Could not resolve tree for Skill directory ${directory}`);
        return {
          ...metadata,
          source: {
            kind:
              selected.owner.toLowerCase() === "openai" &&
              selected.repository.toLowerCase() === "skills" &&
              directory.startsWith("skills/.curated/")
                ? "openai-curated"
                : "github",
            repository: `${selected.owner}/${selected.repository}`,
            ref: selected.reference,
            ...(selected.referenceType ? { ref_type: selected.referenceType } : {}),
            path: directory,
            resolved_commit: selected.commit,
            tree_sha: treeSha,
          },
        } as Candidate;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    });
    currentTask()?.checkpoint();
    const output = results.filter((entry): entry is Candidate => !(entry instanceof Error));
    if (!output.length && results[0] instanceof Error) throw results[0];
    return output.sort((a, b) => a.name.localeCompare(b.name));
  }

  async installed() {
    const lock = await this.#lock();
    const root = path.join(this.root, "skills");
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      );
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const folder = path.join(root, name);
      if (await this.#isLink(folder)) continue;
      const record = lock.skills[name];
      let metadata: SkillMetadata | null = null;
      try {
        metadata = this.#frontmatter(
          await fs.readFile(path.join(folder, "SKILL.md"), "utf8"),
          record?.display_name ?? name,
        );
      } catch {
        if (!record) continue;
      }
      let packageHash: string | null = null;
      let size = 0;
      let modifiedAt: string | null = null;
      try {
        const info = await this.#packageHash(folder);
        packageHash = info.hash;
        size = info.size;
        modifiedAt = info.modifiedAt;
      } catch {
        if (!record) continue;
      }
      result.push({
        name,
        display_name: metadata?.name ?? name,
        description: metadata?.description ?? "",
        path: folder,
        size,
        modified_at: modifiedAt,
        status: !record
          ? "unmanaged"
          : packageHash === record.content_sha256
            ? "current"
            : "modified",
        source: record?.source ?? null,
        upstream_base_hash:
          record?.upstream_base_hash ?? (record?.source ? record.content_sha256 : null),
        locally_customized: Boolean(
          record?.source &&
          record.content_sha256 !== (record.upstream_base_hash ?? record.content_sha256),
        ),
        version_origin: record?.version_origin ?? null,
        installed_at: record?.installed_at ?? null,
        updated_at: record?.updated_at ?? null,
        can_rollback: Boolean(
          lock.previous[name] &&
          (await fs.stat(path.join(this.root, "backups/skills", name)).then(
            (value) => value.isDirectory(),
            () => false,
          )),
        ),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async checkUpdates() {
    const installed = await this.installed();
    const cache = new Map<string, Promise<string>>();
    const results = await Promise.allSettled(
      installed.map(async (skill) => {
        if (!skill.source) return skill;
        try {
          const key = `${skill.source.repository.toLowerCase()}#${skill.source.ref_type ?? ""}:${skill.source.ref}`;
          let commit = cache.get(key);
          if (!commit) {
            commit = this.#commit(
              skill.source.repository.split("/")[0]!,
              skill.source.repository.split("/")[1]!,
              skill.source.ref,
              skill.source.ref_type,
            );
            cache.set(key, commit);
          }
          const selected = await this.#resolve({
            owner: skill.source.repository.split("/")[0]!,
            repository: skill.source.repository.split("/")[1]!,
            selectorPath: skill.source.path,
            reference: await commit,
          });
          const tree = selected.entries.find(
            (entry) => entry.type === "tree" && entry.path === skill.source!.path,
          );
          const treeSha = skill.source.path === "" ? selected.rootTree : tree?.sha;
          return {
            ...skill,
            status:
              treeSha && treeSha !== skill.source.tree_sha ? "update-available" : skill.status,
          };
        } catch (error) {
          if (
            isTaskCancellation(error) ||
            (error instanceof Error && error.name === "TimeoutError")
          )
            throw error;
          currentTask()?.checkpoint();
          return {
            ...skill,
            update_check: "failed",
            update_error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }

  async prepareInstall(source: Source) {
    return this.#prepare(source, "install");
  }
  async #managedDirectory(directory: string, create = false) {
    const relative = path.relative(this.root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Skill operation directory must remain inside AgentKib Home");
    let current = this.root;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      current = part ? path.join(current, part) : current;
      let info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info && create) {
        currentTask()?.checkpoint();
        await fs
          .mkdir(current, { recursive: current === this.root })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        info = await fs.lstat(current);
      }
      if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error("Skill operation directory contains a link or non-directory entry");
    }
  }

  async #targetHash(target: string) {
    await this.#managedDirectory(path.dirname(target));
    return this.#directoryPackageHash(target);
  }

  async #directoryPackageHash(target: string) {
    if (!(await this.#regularDirectory(target))) return null;
    return (await this.#packageHash(target)).hash;
  }

  async #regularDirectory(target: string) {
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Skill target must be a regular directory");
    return info;
  }

  async #snapshotHistory(
    target: string,
    options: { expectedHash?: string; acceptedHash?: string } = {},
  ) {
    await this.#managedDirectory(path.dirname(target));
    if (!(await this.#regularDirectory(target))) return;
    if (options.acceptedHash) {
      try {
        await this.state.verifySnapshot(options.acceptedHash);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const entry = await fs
      .lstat(path.join(target, "SKILL.md"))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    // Damaged history is retained by directory moves, not admitted as a Skill
    // snapshot. Inspecting an absent entry must not hide a real I/O failure.
    if (!entry?.isFile()) return;
    let hash = options.expectedHash;
    if (!hash) {
      const info = await skillPackage(target).catch((error: unknown) => {
        if (
          error instanceof Error &&
          ([
            "Skill path must remain inside its package",
            "Skill package contains too many entries",
            "Skill package exceeds the file limit",
            "Skill package exceeds the total size limit",
          ].includes(error.message) ||
            error.message.startsWith("Skill package contains a non-portable path:") ||
            error.message.startsWith("Skill package contains colliding paths:"))
        )
          return null;
        throw error;
      });
      if (!info || info.diagnostics.length) return;
      hash = info.hash;
    }
    await this.state.snapshot(target, hash);
  }

  #lockFingerprint(entry: LockEntry | undefined) {
    const ordered = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(ordered);
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => compareUtf8(a, b))
          .map(([key, item]) => [key, ordered(item)]),
      );
    };
    return JSON.stringify(ordered(entry ?? null));
  }

  async #staging() {
    const directory = path.join(this.root, ".staging", "skills");
    await this.#managedDirectory(directory, true);
    await this.#managedDirectory(path.join(this.root, "skills"), true);
    const [staging, target] = await Promise.all([
      fs.stat(directory),
      fs.stat(path.join(this.root, "skills")),
    ]);
    if (staging.dev !== target.dev)
      throw new Error("Skill staging and library must be on the same volume");
    const tempPath = await fs.mkdtemp(path.join(directory, `preview-${randomUUID()}-`));
    activePreviewDirectories.add(tempPath);
    try {
      await this.#writePreviewMetadata(
        tempPath,
        new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      );
      return tempPath;
    } catch (error) {
      activePreviewDirectories.delete(tempPath);
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  async #writePreviewMetadata(tempPath: string, expiresAt: string) {
    await this.#managedDirectory(tempPath);
    const directory = path.basename(tempPath);
    const marker = path.join(tempPath, PREVIEW_METADATA_FILE);
    const temporary = `${marker}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify({
          schema_version: 1,
          kind: "agentkib-skill-preview",
          id: directory.slice(8, 44),
          root: path.resolve(this.root),
          directory,
          expires_at: expiresAt,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await fs.rename(temporary, marker);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async #expireOrphanPreviews(now: number) {
    const staging = path.join(this.root, ".staging", "skills");
    await this.#managedDirectory(staging);
    const directories = await fs.readdir(staging).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const directory of directories) {
      const tempPath = path.join(staging, directory);
      if (activePreviewDirectories.has(tempPath)) continue;
      const info = await fs.lstat(tempPath).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const marker = path.join(tempPath, PREVIEW_METADATA_FILE);
      const markerInfo = await fs.lstat(marker).catch(() => null);
      if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) continue;
      const handle = await fs
        .open(marker, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        .catch(() => null);
      if (!handle) continue;
      let owned = false;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.size > 4096 ||
          opened.dev !== markerInfo.dev ||
          opened.ino !== markerInfo.ino
        )
          continue;
        const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
        const expires = typeof value.expires_at === "string" ? Date.parse(value.expires_at) : NaN;
        owned =
          value.schema_version === 1 &&
          value.kind === "agentkib-skill-preview" &&
          typeof value.id === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) &&
          directory.startsWith(`preview-${value.id}-`) &&
          /^[a-zA-Z0-9]{6}$/.test(directory.slice(45)) &&
          value.directory === directory &&
          value.root === path.resolve(this.root) &&
          Number.isFinite(expires) &&
          new Date(expires).toISOString() === value.expires_at &&
          expires <= now;
      } catch {
        // Unknown or invalid receipts never authorize removing a directory.
      } finally {
        await handle.close();
      }
      if (!owned || activePreviewDirectories.has(tempPath)) continue;
      await this.#managedDirectory(staging);
      const current = await fs.lstat(tempPath).catch(() => null);
      if (
        !current?.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        activePreviewDirectories.has(tempPath)
      )
        continue;
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  }

  async #expirePreviews() {
    const now = Date.now();
    await this.#managedDirectory(path.join(this.root, ".staging", "skills"));
    for (const [token, prepared] of this.#previews) {
      if (
        Date.parse(String(prepared.preview.expires_at)) > now ||
        activePreviewDirectories.has(prepared.tempPath)
      )
        continue;
      this.#previews.delete(token);
      await fs.rm(prepared.tempPath, { recursive: true, force: true });
    }
    for (const [token, batch] of this.#imports) {
      if (
        Date.parse(batch.expires_at) > now ||
        [...batch.prepared.values()].some((item) => activePreviewDirectories.has(item.tempPath))
      )
        continue;
      this.#imports.delete(token);
      await Promise.all(
        [...batch.prepared.values()].map((item) =>
          fs.rm(item.tempPath, { recursive: true, force: true }),
        ),
      );
    }
    await this.#expireOrphanPreviews(now);
  }

  async discardPreview(token: string) {
    await this.#expirePreviews();
    const prepared = this.#previews.get(token);
    const batch = this.#imports.get(token);
    this.#previews.delete(token);
    this.#imports.delete(token);
    const paths = [
      ...(prepared ? [prepared.tempPath] : []),
      ...[...(batch?.prepared.values() ?? [])].map((item) => item.tempPath),
    ];
    await Promise.all(paths.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    return { discarded: Boolean(prepared || batch) };
  }

  async #withPreviewRetention<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#previewRetention;
    let release!: () => void;
    this.#previewRetention = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #remember(prepared: Prepared) {
    return this.#withPreviewRetention(async () => {
      try {
        while (this.#previews.size >= 4) {
          const oldest = [...this.#previews].find(
            ([, item]) => !activePreviewDirectories.has(item.tempPath),
          );
          if (!oldest) throw new Error("Skill previews are being applied; retry preparation later");
          const [token, previous] = oldest;
          this.#previews.delete(token);
          await fs.rm(previous.tempPath, { recursive: true, force: true });
        }
        if (this.#retainedBytes() + prepared.stagedBytes > MAX_STAGED_BYTES)
          throw new Error(
            "Skill previews exceed the 1 GiB staging limit; close an existing preview",
          );
        await this.#writePreviewMetadata(prepared.tempPath, String(prepared.preview.expires_at));
        this.#previews.set(String(prepared.preview.token), prepared);
      } catch (error) {
        await fs.rm(prepared.tempPath, { recursive: true, force: true });
        throw error;
      } finally {
        activePreviewDirectories.delete(prepared.tempPath);
      }
    });
  }

  #retainedBytes() {
    return (
      [...this.#previews.values()].reduce((sum, item) => sum + item.stagedBytes, 0) +
      [...this.#imports.values()].reduce((sum, item) => sum + item.total_size, 0)
    );
  }

  async #reservedNames(lock: LockFile) {
    await this.#managedDirectory(path.join(this.root, "skills"));
    const names = await fs
      .readdir(path.join(this.root, "skills"))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    return new Set(
      [...names, ...Object.keys(lock.skills)].map((name) => name.normalize("NFC").toLowerCase()),
    );
  }

  #allocateName(name: string, identity: string, reserved: Set<string>, maximumLength?: number) {
    let candidate = name;
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    for (let suffix = 1; reserved.has(candidate.normalize("NFC").toLowerCase()); suffix++) {
      const ending = `--${digest}${suffix === 1 ? "" : `-${suffix}`}`;
      const prefix = maximumLength ? name.slice(0, maximumLength - ending.length) : name;
      candidate = `${prefix}${ending}`;
    }
    reserved.add(candidate.normalize("NFC").toLowerCase());
    return candidate;
  }

  #allocateLocalName(displayName: string, identity: string, reserved: Set<string>) {
    // A directory fallback is a display name. Native copies still need a safe,
    // bounded ID, including the collision suffix, without rewriting SKILL.md.
    const base =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "skill";
    this.#validateSkillName(base);
    return this.#allocateName(base, identity, reserved, 64);
  }

  async #prepareLocal(observation: Observation, reserved: Set<string>, lock: LockFile) {
    if (!observation.resolved_path) throw new Error("Observed Skill location cannot be resolved");
    const source = await fs.realpath(observation.resolved_path);
    const initial = await skillPackage(source);
    if (initial.diagnostics.length) throw new Error(initial.diagnostics.join("; "));
    const tempPath = await this.#staging();
    const packagePath = path.join(tempPath, "package");
    try {
      await copySkillPackage(source, packagePath);
      if ((await skillPackage(source)).hash !== initial.hash)
        throw new Error("Observed Skill changed while preparing the import");
      const metadata = this.#frontmatter(
        await fs.readFile(path.join(packagePath, "SKILL.md"), "utf8"),
        path.basename(observation.path),
        true,
      );
      const name = this.#allocateLocalName(metadata.name, source, reserved);
      const packageHash = await this.#packageHash(packagePath);
      const files = (await skillPackage(packagePath)).files.map(({ path, size, executable }) => ({
        path,
        size,
        executable,
      }));
      const now = new Date().toISOString();
      return {
        preview: {
          token: randomUUID(),
          operation: "install",
          library_id: name,
          skill: { ...metadata, source: null },
          files,
          added: files.map((file) => file.path),
          modified: [],
          removed: [],
          total_size: packageHash.size,
          local_modified: false,
          expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
        },
        name,
        packagePath,
        tempPath,
        beforePath: null,
        stagedBytes: packageHash.size,
        lock: {
          source: null,
          content_sha256: packageHash.hash,
          installed_at: now,
          updated_at: now,
          display_name: metadata.name,
          local_source: observation.path,
          local_resolved_path: source,
        },
        expectedHash: null,
        expectedLock: this.#lockFingerprint(lock.skills[name]),
      } satisfies Prepared;
    } catch (error) {
      activePreviewDirectories.delete(tempPath);
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  async prepareImport(observationId: string) {
    await this.#expirePreviews();
    const observation = (await this.manager.inventory()).observations.find(
      (item) => item.id === observationId,
    );
    if (!observation) throw new Error("Skill observation no longer exists; refresh the inventory");
    const lock = await this.#lock();
    const prepared = await this.#prepareLocal(observation, await this.#reservedNames(lock), lock);
    await this.#remember(prepared);
    return prepared.preview;
  }

  async prepareImports(params: Record<string, unknown>) {
    const ids = params.observation_ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 4096 ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Choose 1 to 4096 unique Skill observation IDs");
    await this.#expirePreviews();
    if (this.#imports.size >= 4)
      throw new Error("Close an existing import preview before preparing another batch");
    const inventory = await this.manager.inventory();
    const lock = await this.#lock();
    const reserved = await this.#reservedNames(lock);
    const batch: ImportBatch = {
      token: randomUUID(),
      expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      total_size: 0,
      items: [],
      prepared: new Map(),
      skipped: new Map(),
    };
    const discardPrepared = async (id: string) => {
      const prepared = batch.prepared.get(id);
      if (!prepared) return;
      activePreviewDirectories.delete(prepared.tempPath);
      await fs.rm(prepared.tempPath, { recursive: true, force: true });
      batch.total_size -= prepared.stagedBytes;
      batch.prepared.delete(id);
    };
    const groups = new Map<string, { item: ImportItem; hash?: string }>();
    try {
      for (const id of ids as string[]) {
        const observation = inventory.observations.find((item) => item.id === id);
        let item: ImportItem = {
          id: randomUUID(),
          observation_ids: [id],
          paths: observation ? [observation.path] : [],
          agents: observation?.agents ?? [],
          resolved_path: observation?.resolved_path ?? null,
          library_id: null,
          display_name: observation?.name ?? id,
          status: "failed",
        };
        let merged = false;
        try {
          if (!observation?.resolved_path)
            throw new Error("Observed Skill location cannot be resolved; refresh the inventory");
          const source = await fs.realpath(observation.resolved_path);
          const sourceKey = process.platform === "win32" ? source.toLowerCase() : source;
          const previousGroup = groups.get(sourceKey);
          if (previousGroup) {
            item = previousGroup.item;
            merged = true;
            item.observation_ids.push(id);
            item.paths = [...new Set([...item.paths, observation.path])];
            item.agents = [...new Set([...item.agents, ...observation.agents])];
            if (item.status === "failed") continue;
          } else {
            item.resolved_path = source;
            // Establish physical identity even if complete-package validation fails.
            groups.set(sourceKey, { item });
          }
          const pkg = await skillPackage(source);
          if (pkg.diagnostics.length) throw new Error(pkg.diagnostics.join("; "));
          if (previousGroup) {
            if (previousGroup.hash !== pkg.hash)
              throw new Error("Observed Skill changed between linked locations; refresh and retry");
            continue;
          }
          groups.set(sourceKey, { item, hash: pkg.hash });
          let existingName: string | undefined;
          const existingDiagnostics: string[] = [];
          for (const [name, record] of Object.entries(lock.skills)) {
            const origin = record.local_resolved_path ?? record.local_source;
            if (!origin) continue;
            // A recorded real path is frozen provenance, even if that path now
            // points somewhere else. Only legacy entry paths need resolving.
            const real = record.local_resolved_path
              ? path.resolve(record.local_resolved_path)
              : await fs.realpath(origin).catch(() => path.resolve(origin));
            if (
              (process.platform === "win32" ? real.toLowerCase() : real) !== sourceKey ||
              record.content_sha256 !== pkg.hash
            )
              continue;
            this.#validateId(name);
            const target = path.join(this.root, "skills", name);
            // Management-path failures still block the operation; only a damaged
            // candidate package is excluded from deduplication and preserved.
            await this.#managedDirectory(path.dirname(target));
            try {
              if ((await this.#directoryPackageHash(target)) === pkg.hash) {
                existingName = name;
                break;
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              existingDiagnostics.push(
                `Existing library snapshot "${name}" could not be verified and was not used for deduplication: ${reason}`,
              );
            }
          }
          if (existingName) {
            item.status = "skipped";
            item.library_id = existingName;
            item.reason = [
              "This source and its complete contents are already in the library",
              ...existingDiagnostics,
            ].join("; ");
            batch.skipped.set(item.id, {
              name: existingName,
              expectedHash: pkg.hash,
              expectedLock: this.#lockFingerprint(lock.skills[existingName]),
            });
          } else if (this.#retainedBytes() + batch.total_size + pkg.totalSize > MAX_STAGED_BYTES) {
            throw new Error(
              "Import previews exceed the 1 GiB staging limit; import a smaller selection",
            );
          } else {
            const prepared = await this.#prepareLocal(observation, reserved, lock);
            // Require the exact source version used to group this batch's aliases.
            if (prepared.lock.content_sha256 !== pkg.hash) {
              activePreviewDirectories.delete(prepared.tempPath);
              await fs.rm(prepared.tempPath, { recursive: true, force: true });
              throw new Error(
                "Observed Skill changed while preparing the batch; refresh and retry",
              );
            }
            item.status = "ready";
            item.library_id = prepared.name;
            item.preview = prepared.preview;
            item.display_name = prepared.lock.display_name!;
            const notes = [
              ...inventory.warnings,
              ...observation.diagnostics,
              ...existingDiagnostics,
            ];
            if (observation.status !== "observed")
              notes.unshift(
                `Native status: ${observation.status}; copying does not change native configuration`,
              );
            if (notes.length) item.reason = [...new Set(notes)].join("; ");
            batch.total_size += Number(prepared.preview.total_size);
            batch.prepared.set(item.id, prepared);
          }
        } catch (error) {
          item.status = "failed";
          item.reason = error instanceof Error ? error.message : String(error);
          item.library_id = null;
          delete item.preview;
          batch.skipped.delete(item.id);
          await discardPrepared(item.id);
        }
        if (!merged) batch.items.push(item);
      }
      // Recheck and register the batch alongside single previews so metadata
      // writes cannot let another preparation consume the same remaining budget.
      await this.#withPreviewRetention(async () => {
        for (const item of [...batch.items].reverse()) {
          if (this.#retainedBytes() + batch.total_size <= MAX_STAGED_BYTES) break;
          if (!batch.prepared.has(item.id)) continue;
          await discardPrepared(item.id);
          item.status = "failed";
          item.reason = "Skill previews exceed the 1 GiB staging limit; import a smaller selection";
          item.library_id = null;
          delete item.preview;
        }
        batch.expires_at = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
        for (const prepared of batch.prepared.values()) {
          prepared.preview.expires_at = batch.expires_at;
          await this.#writePreviewMetadata(prepared.tempPath, batch.expires_at);
        }
        this.#imports.set(batch.token, batch);
        for (const prepared of batch.prepared.values())
          activePreviewDirectories.delete(prepared.tempPath);
      });
      const { prepared: _, skipped: _skipped, ...preview } = batch;
      return preview;
    } catch (error) {
      await Promise.all(
        [...batch.prepared.values()].map(async (item) => {
          activePreviewDirectories.delete(item.tempPath);
          await fs.rm(item.tempPath, { recursive: true, force: true });
        }),
      );
      throw error;
    }
  }

  async applyImports(params: Record<string, unknown>) {
    if (params.confirmed !== true) throw new Error("Skill import requires explicit confirmation");
    const token = this.#string(params.token, "token");
    const completed = this.#importResults.get(token);
    if (completed) return structuredClone(completed);
    const batch = this.#imports.get(token);
    const valid = batch !== undefined && Date.parse(batch.expires_at) > Date.now();
    const directories = valid ? [...batch.prepared.values()].map((item) => item.tempPath) : [];
    // Reserve snapshots before the first await: another instance can expire
    // orphaned previews while this request is checking its own preview maps.
    for (const directory of directories) activePreviewDirectories.add(directory);
    try {
      await this.#expirePreviews();
      if (!batch || !valid) throw new Error("Skill import preview expired or does not exist");
      this.#imports.delete(token);
      const report: ImportReport = { token, items: [] };
      try {
        for (const item of batch.items) {
          if (item.status === "failed") {
            report.items.push({
              id: item.id,
              observation_ids: item.observation_ids,
              status: item.status,
              ...(item.library_id ? { library_id: item.library_id } : {}),
              ...(item.status === "failed" ? { error: item.reason } : {}),
            });
            continue;
          }
          try {
            currentTask()?.checkpoint();
            if (item.status === "skipped") {
              const skipped = batch.skipped.get(item.id)!;
              const actual = await this.#targetHash(path.join(this.root, "skills", skipped.name));
              if (actual !== skipped.expectedHash)
                throw new Error(
                  "Installed Skill changed after preview; prepare the operation again",
                );
              const lock = await this.#lock();
              if (this.#lockFingerprint(lock.skills[skipped.name]) !== skipped.expectedLock)
                throw new Error(
                  "Installed Skill source record changed after preview; prepare the operation again",
                );
              report.items.push({
                id: item.id,
                observation_ids: item.observation_ids,
                status: "skipped",
                library_id: skipped.name,
              });
              continue;
            }
            const skill = await this.#applyPrepared(batch.prepared.get(item.id)!);
            report.items.push({
              id: item.id,
              observation_ids: item.observation_ids,
              status: "imported",
              library_id: skill.name,
              skill,
              ...(skill.warnings?.length ? { warnings: skill.warnings } : {}),
            });
          } catch (error) {
            report.items.push({
              id: item.id,
              observation_ids: item.observation_ids,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        const cleanup = await Promise.allSettled(
          [...batch.prepared.values()].map(async (item) => {
            await fs.rm(item.tempPath, { recursive: true, force: true });
          }),
        );
        if (cleanup.some((result) => result.status === "rejected"))
          report.warnings = ["Imports finished, but temporary files could not all be removed"];
      }
      // Reports hold no staged files and retain token idempotency for this process.
      this.#importResults.set(token, structuredClone(report));
      return report;
    } finally {
      for (const directory of directories) activePreviewDirectories.delete(directory);
    }
  }

  async readPreviewFile(params: Record<string, unknown>) {
    await this.#expirePreviews();
    const token = this.#string(params.token, "token");
    const relative = this.#string(params.path, "path");
    const prepared =
      params.item_id === undefined
        ? this.#previews.get(token)
        : this.#imports.get(token)?.prepared.get(this.#string(params.item_id, "item_id"));
    if (!prepared) throw new Error("Skill preview expired or does not exist");
    return skillPreviewFile(prepared.beforePath, prepared.packagePath, relative);
  }
  async prepareUpdate(name: string) {
    this.#validateId(name);
    const lock = await this.#lock();
    const source = lock.skills[name]?.source;
    if (!source) throw new Error("Unmanaged Skills cannot be updated");
    return this.#prepare(source, "update", name);
  }

  #selector(value: unknown): VersionSelector {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Choose a tag, branch, or commit");
    const selector = value as Record<string, unknown>;
    if (
      !["tag", "branch", "commit"].includes(String(selector.type)) ||
      typeof selector.value !== "string"
    )
      throw new Error("Choose a tag, branch, or commit");
    const ref = selector.value.trim();
    if (selector.type === "commit") {
      if (!/^[a-f0-9]{7,40}$/i.test(ref))
        throw new Error("Commit must be a 7 to 40 character hexadecimal SHA");
    } else if (
      !ref ||
      ref.length > 255 ||
      /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref) ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.startsWith("-") ||
      ref
        .split("/")
        .some(
          (part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
        )
    ) {
      throw new Error("Git reference is invalid");
    }
    return { type: selector.type as VersionSelector["type"], value: ref };
  }

  async listVersions(params: Record<string, unknown>) {
    if ((params.library_id !== undefined) === (params.source !== undefined))
      throw new Error("Choose exactly one installed Skill or source");
    if (params.type !== "tag" && params.type !== "branch")
      throw new Error("Version type must be tag or branch");
    const page = params.page ?? 1;
    if (!Number.isInteger(page) || Number(page) < 1 || Number(page) > 10_000)
      throw new Error("Version page must be an integer from 1 to 10000");
    let source: Source | null | undefined;
    if (params.library_id !== undefined) {
      const name = this.#string(params.library_id, "library_id");
      this.#validateId(name);
      source = (await this.#lock()).skills[name]?.source;
    } else source = params.source as Source;
    if (!source || typeof source.repository !== "string")
      throw new Error("Skill has no GitHub source");
    const [owner, repository, extra] = source.repository.split("/");
    if (!owner || !repository || extra !== undefined) throw new Error("Invalid Skill repository");
    this.#validateRepoSegment(owner);
    this.#validateRepoSegment(repository);
    const values = await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${params.type === "tag" ? "tags" : "branches"}?per_page=50&page=${page}`,
    );
    if (!Array.isArray(values)) throw new Error("GitHub returned an invalid version list");
    const entries = values.map((entry: unknown) => {
      const item = entry as { name?: unknown; commit?: { sha?: unknown } };
      if (
        typeof item?.name !== "string" ||
        typeof item.commit?.sha !== "string" ||
        !/^[a-f0-9]{40}$/i.test(item.commit.sha)
      )
        throw new Error("GitHub returned an invalid version entry");
      return { name: item.name, commit: item.commit.sha };
    });
    return { entries, type: params.type, page: Number(page), has_more: entries.length === 50 };
  }

  async prepareVersionChange(params: Record<string, unknown>) {
    const name = this.#string(params.library_id, "library_id");
    this.#validateId(name);
    const selector = this.#selector(params.selector);
    const source = (await this.#lock()).skills[name]?.source;
    if (!source)
      throw new Error("Skill has no GitHub source; local imports cannot switch remote versions");
    return this.#prepare(
      { ...source, ref: selector.value, ref_type: selector.type },
      "update",
      name,
      true,
    );
  }

  async apply(params: Record<string, unknown>) {
    if (params.confirmed !== true)
      throw new Error("Skill installation requires explicit confirmation");
    const token = this.#string(params.token, "token");
    const prepared = this.#previews.get(token);
    const valid =
      prepared !== undefined && Date.parse(String(prepared.preview.expires_at)) > Date.now();
    if (valid) activePreviewDirectories.add(prepared.tempPath);
    try {
      await this.#expirePreviews();
      if (!prepared || !valid) throw new Error("Skill preview expired or does not exist");
      if (prepared.preview.local_modified === true && params.allowModified !== true)
        throw new Error(
          "The installed Skill was modified locally; replacement requires confirmation",
        );
      this.#previews.delete(token);
      return await this.#applyPrepared(prepared);
    } finally {
      if (valid) activePreviewDirectories.delete(prepared.tempPath);
    }
  }

  async #applyPrepared(prepared: Prepared): Promise<Installed> {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      return this.#applyPreparedLocked(prepared);
    });
  }

  async #recoverBeforeWrite() {
    const results = await recoverLibraryTransactions(this.root);
    if (results.some((result) => result.status === "recovery-required"))
      throw new Error("An interrupted Skill operation requires recovery before another write");
  }

  async #applyPreparedLocked(prepared: Prepared): Promise<Installed> {
    let committed = false;
    const warnings: string[] = [];
    try {
      const target = path.join(this.root, "skills", prepared.name);
      const actual = await this.#targetHash(target);
      if (actual !== prepared.expectedHash)
        throw new Error("Installed Skill changed after preview; prepare the operation again");
      const lock = await this.#lock();
      const old = lock.skills[prepared.name];
      if (this.#lockFingerprint(old) !== prepared.expectedLock)
        throw new Error(
          "Installed Skill source record changed after preview; prepare the operation again",
        );
      if (
        prepared.preview.operation === "install" &&
        prepared.lock.source &&
        this.#findRemotePackage(lock, prepared.lock.source)
      )
        throw new Error("Skill source was installed after preview; prepare the operation again");
      if ((await this.#targetHash(prepared.packagePath)) !== prepared.lock.content_sha256)
        throw new Error("Prepared Skill contents changed; prepare the operation again");
      const metadata = this.#frontmatter(
        await fs.readFile(path.join(prepared.packagePath, "SKILL.md"), "utf8"),
        prepared.lock.display_name ?? prepared.name,
      );
      const packageInfo = await this.#packageHash(prepared.packagePath);
      const result: Installed = {
        name: prepared.name,
        display_name: metadata.name,
        description: metadata.description,
        path: target,
        size: packageInfo.size,
        modified_at: packageInfo.modifiedAt,
        status: "current",
        source: prepared.lock.source,
        upstream_base_hash: prepared.lock.upstream_base_hash ?? null,
        locally_customized: Boolean(
          prepared.lock.source &&
          prepared.lock.upstream_base_hash &&
          prepared.lock.content_sha256 !== prepared.lock.upstream_base_hash,
        ),
        version_origin: prepared.lock.version_origin ?? null,
        installed_at: prepared.lock.installed_at,
        updated_at: prepared.lock.updated_at,
        can_rollback: Boolean(old),
      };
      const backup = path.join(this.root, "backups/skills", prepared.name);
      await this.#managedDirectory(path.dirname(target), true);
      await this.#managedDirectory(path.dirname(backup), true);
      // Directory safety is independent of damaged backup contents. Existing
      // accepted snapshots are reused; valid legacy history is archived below
      // only when its immutable snapshot is missing.
      const hasExistingBackup = (await this.#regularDirectory(backup)) !== null;
      const volumes = await Promise.all(
        [prepared.tempPath, path.dirname(target), path.dirname(backup)].map((directory) =>
          fs.stat(directory),
        ),
      );
      if (volumes.some((info) => info.dev !== volumes[0]!.dev))
        throw new Error("Skill staging, backup and library must be on the same volume");
      return await commitTask(async () => {
        await prepared.beforeCommit?.();
        const operationId = prepared.operationId ?? randomUUID();
        const transactionRoot = path.join(this.root, ".skill-state/library-staging", operationId);
        await this.#managedDirectory(transactionRoot, true);
        const incoming = path.join(transactionRoot, "incoming");
        await copySkillPackage(prepared.packagePath, incoming);
        const incomingHash = await this.state.snapshot(incoming, prepared.lock.content_sha256);
        if (old && actual) await this.#snapshotHistory(target, { expectedHash: actual });
        if (hasExistingBackup)
          await this.#snapshotHistory(backup, {
            acceptedHash: lock.previous[prepared.name]?.content_sha256,
          });
        const oldLock = await readSkillJson(path.join(this.root, "skills.lock.json"));
        const origin =
          prepared.preview.operation === "update"
            ? {
                kind: "github" as const,
                operation_id: operationId,
              }
            : (prepared.lock.version_origin ?? {
                kind: prepared.lock.source ? ("github" as const) : ("local-import" as const),
                operation_id: operationId,
              });
        lock.schema_version = 2;
        lock.skills[prepared.name] = {
          ...prepared.lock,
          snapshot_hash: incomingHash,
          hash_algorithm: SKILL_HASH_ALGORITHM,
          library_instance_id: old?.library_instance_id ?? old?.installed_at ?? randomUUID(),
          upstream_base_hash:
            prepared.lock.upstream_base_hash ?? (prepared.lock.source ? incomingHash : null),
          version_origin: origin,
        };
        if (old)
          lock.previous[prepared.name] = {
            ...old,
            ...(actual === old.content_sha256
              ? { snapshot_hash: actual, hash_algorithm: SKILL_HASH_ALGORITHM }
              : {}),
          };
        const moves: Array<{ from: string; to: string }> = [];
        const stagedBackup = `${backup}.staging-${operationId}`;
        if (hasExistingBackup) moves.push({ from: backup, to: stagedBackup });
        if (old && actual !== null) moves.push({ from: target, to: backup });
        moves.push({ from: incoming, to: target });
        if (
          (await this.#targetHash(target)) !== prepared.expectedHash ||
          this.#lockFingerprint((await this.#lock()).skills[prepared.name]) !==
            prepared.expectedLock ||
          (await this.#targetHash(incoming)) !== incomingHash
        )
          throw new Error(
            "Skill contents or ownership changed before commit; prepare the operation again",
          );
        const transaction = await executeLibraryTransaction(this.root, {
          id: operationId,
          operation: String(prepared.preview.operation),
          library_id: prepared.name,
          old_lock: oldLock,
          new_lock: lock,
          moves,
          cleanup: [...(hasExistingBackup ? [stagedBackup] : []), transactionRoot],
        });
        if (transaction?.cleanup_pending)
          warnings.push("Skill was saved, but the older backup could not be removed");
        committed = true;
        let refreshed = result;
        try {
          const current = (await this.installed()).find((item) => item.name === prepared.name);
          if (current) refreshed = current;
          else warnings.push("Skill was saved, but the library refresh did not return its record");
        } catch {
          warnings.push("Skill was saved, but refreshing the library failed");
        }
        try {
          await fs.rm(prepared.tempPath, { recursive: true, force: true });
        } catch {
          warnings.push("Skill was saved, but temporary files could not be removed");
        }
        return warnings.length ? { ...refreshed, warnings } : refreshed;
      });
    } finally {
      if (!committed)
        await fs.rm(prepared.tempPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async rollback(params: Record<string, unknown>) {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      return this.#rollbackLocked(params);
    });
  }

  async #rollbackLocked(params: Record<string, unknown>) {
    if (params.confirmed !== true) throw new Error("Skill rollback requires explicit confirmation");
    const name = this.#string(params.name, "name");
    this.#validateId(name);
    const target = path.join(this.root, "skills", name);
    const backup = path.join(this.root, "backups/skills", name);
    await this.#managedDirectory(path.dirname(target));
    // Recovery only moves the current directory; damaged contents must not
    // prevent restoring a valid backup or require following internal links.
    const [currentDirectory, backupHash] = await Promise.all([
      this.#regularDirectory(target),
      this.#targetHash(backup),
    ]);
    if (currentDirectory === null || backupHash === null)
      throw new Error("No rollback version is available");
    const lock = await this.#lock();
    const current = lock.skills[name];
    const previous = lock.previous[name];
    if (!current || !previous) throw new Error("Rollback metadata is missing");
    const metadata = this.#frontmatter(
      await fs.readFile(path.join(backup, "SKILL.md"), "utf8"),
      previous.display_name ?? name,
    );
    const packageInfo = await this.#packageHash(backup);
    const result: Installed = {
      name,
      display_name: metadata.name,
      description: metadata.description,
      path: target,
      size: packageInfo.size,
      modified_at: packageInfo.modifiedAt,
      status: backupHash === previous.content_sha256 ? "current" : "modified",
      source: previous.source,
      upstream_base_hash:
        previous.upstream_base_hash ?? (previous.source ? previous.content_sha256 : null),
      locally_customized: Boolean(
        previous.source &&
        previous.upstream_base_hash &&
        previous.content_sha256 !== previous.upstream_base_hash,
      ),
      version_origin: previous.version_origin ?? null,
      installed_at: previous.installed_at,
      updated_at: previous.updated_at,
      can_rollback: true,
    };
    return commitTask(async () => {
      const operationId = randomUUID();
      const transactionRoot = path.join(this.root, ".skill-state/library-staging", operationId);
      await this.#managedDirectory(transactionRoot, true);
      const staging = path.join(transactionRoot, "current");
      await this.state.snapshot(backup, backupHash);
      await this.#snapshotHistory(target);
      const oldLock = await readSkillJson(path.join(this.root, "skills.lock.json"));
      lock.schema_version = 2;
      lock.skills[name] = {
        ...previous,
        ...(backupHash === previous.content_sha256
          ? { snapshot_hash: backupHash, hash_algorithm: SKILL_HASH_ALGORITHM }
          : {}),
      };
      lock.previous[name] = current;
      await this.sync.pauseLibrary(name);
      await executeLibraryTransaction(this.root, {
        id: operationId,
        operation: "rollback",
        library_id: name,
        old_lock: oldLock,
        new_lock: lock,
        moves: [
          { from: target, to: staging },
          { from: backup, to: target },
          { from: staging, to: backup },
        ],
        cleanup: [transactionRoot],
      });
      try {
        return (
          (await this.installed()).find((item) => item.name === name) ?? {
            ...result,
            warnings: [
              "Skill rollback succeeded, but the library refresh did not return its record",
            ],
          }
        );
      } catch {
        return {
          ...result,
          warnings: ["Skill rollback succeeded, but refreshing the library failed"],
        };
      }
    });
  }

  async uninstall(params: Record<string, unknown>) {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      return this.#uninstallLocked(params);
    });
  }

  async #uninstallLocked(params: Record<string, unknown>) {
    if (params.confirmed !== true)
      throw new Error("Skill uninstall requires explicit confirmation");
    const name = this.#string(params.name, "name");
    this.#validateId(name);
    await this.sync.assertLibraryRemovable(name);
    if (
      (await this.manager.listDeployments()).some(
        (deployment) =>
          deployment.source_is_current_library &&
          deployment.library_id === name &&
          deployment.status !== "inactive",
      )
    )
      throw new Error("Withdraw active Skill deployments before removing the library package");
    const target = path.join(this.root, "skills", name);
    const id = `skill-${randomUUID()}`;
    const root = path.join(this.root, "trash/skills", id);
    const lock = await this.#lock();
    const record = {
      id,
      name,
      display_name:
        (typeof lock.skills[name]?.display_name === "string" && lock.skills[name]?.display_name) ||
        (await this.#displayName(target, name)),
      removed_at: new Date().toISOString(),
      lock: lock.skills[name] ?? null,
      previous: lock.previous[name] ?? null,
    };
    return commitTask(async () => {
      await this.#managedDirectory(root, true);
      await this.#writeJson(path.join(root, "record.json"), record);
      await this.#snapshotHistory(target);
      const backup = path.join(this.root, "backups/skills", name);
      const hasBackup = (await this.#regularDirectory(backup)) !== null;
      if (hasBackup) await this.#snapshotHistory(backup);
      const oldLock = await readSkillJson(path.join(this.root, "skills.lock.json"));
      delete lock.skills[name];
      delete lock.previous[name];
      lock.schema_version = 2;
      await this.sync.pauseLibrary(name);
      await executeLibraryTransaction(this.root, {
        id,
        operation: "uninstall",
        library_id: name,
        old_lock: oldLock,
        new_lock: lock,
        moves: [
          { from: target, to: path.join(root, "package") },
          ...(hasBackup ? [{ from: backup, to: path.join(root, "backup") }] : []),
        ],
      });
      return {
        id,
        name,
        display_name: record.display_name,
        removed_at: record.removed_at,
        path: path.join(root, "package"),
      };
    });
  }

  async removed() {
    const directory = path.join(this.root, "trash/skills");
    const names = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      );
    const output: Array<Record<string, unknown> & { removed_at: string }> = [];
    for (const item of names) {
      if (!item.isDirectory() || (await this.#isLink(path.join(directory, item.name)))) continue;
      try {
        const record = (await this.#readJson(
          path.join(directory, item.name, "record.json"),
        )) as Record<string, unknown>;
        const pkg = path.join(directory, item.name, "package");
        if (
          !(await fs.stat(pkg).then(
            (s) => s.isDirectory(),
            () => false,
          )) ||
          (await this.#isLink(pkg))
        )
          continue;
        if (typeof record.removed_at !== "string") continue;
        output.push({ ...record, removed_at: record.removed_at, path: pkg });
      } catch {
        /* Invalid trash records are not restorable. */
      }
    }
    return output.sort(
      (a, b) => Date.parse(String(b.removed_at)) - Date.parse(String(a.removed_at)),
    );
  }

  async restore(params: Record<string, unknown>) {
    return withSkillLocks([this.root], async () => {
      await this.#recoverBeforeWrite();
      return this.#restoreLocked(params);
    });
  }

  async #restoreLocked(params: Record<string, unknown>) {
    if (params.confirmed !== true) throw new Error("Skill restore requires explicit confirmation");
    const id = this.#string(params.id, "id");
    if (!/^skill-[a-zA-Z0-9-]{1,150}$/.test(id)) throw new Error("Removed Skill id is invalid");
    const root = path.join(this.root, "trash/skills", id);
    const record = (await this.#readJson(path.join(root, "record.json"))) as Record<
      string,
      unknown
    >;
    const name = this.#string(record.name, "name");
    this.#validateId(name);
    const target = path.join(this.root, "skills", name);
    if (
      await fs.stat(target).then(
        () => true,
        () => false,
      )
    )
      throw new Error("A Skill with this name already exists");
    return commitTask(async () => {
      await this.#managedDirectory(path.dirname(target), true);
      const packagePath = path.join(root, "package");
      const restoredHash = await this.#targetHash(packagePath);
      if (!restoredHash) throw new Error("Removed Skill package is missing");
      await this.state.snapshot(packagePath, restoredHash);
      const backup = path.join(this.root, "backups/skills", name);
      await this.#managedDirectory(path.dirname(backup), true);
      const hasBackup = (await this.#regularDirectory(path.join(root, "backup"))) !== null;
      const lock = await this.#lock();
      const oldLock = await readSkillJson(path.join(this.root, "skills.lock.json"));
      if (lock.skills[name]) throw new Error("Skill library identity is already in use");
      if (record.lock) lock.skills[name] = record.lock as LockEntry;
      if (record.previous) lock.previous[name] = record.previous as LockEntry;
      lock.schema_version = 2;
      await executeLibraryTransaction(this.root, {
        id: randomUUID(),
        operation: "restore",
        library_id: name,
        old_lock: oldLock,
        new_lock: lock,
        moves: [
          { from: packagePath, to: target },
          ...(hasBackup ? [{ from: path.join(root, "backup"), to: backup }] : []),
        ],
        cleanup: [root],
      });
      return (await this.installed()).find((item) => item.name === name);
    });
  }

  async readFile(params: Record<string, unknown>) {
    const name = this.#string(params.name, "name");
    const relative = this.#string(params.path, "path");
    this.#validateId(name);
    const parts = relative.replaceAll("\\", "/").split("/");
    if (
      !relative ||
      path.isAbsolute(relative) ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Skill resource path is invalid");
    const root = await fs.realpath(path.join(this.root, "skills", name));
    const file = await fs.realpath(path.join(root, relative));
    const components = relative.replaceAll("\\", "/").split("/");
    const supported =
      components[0] === "SKILL.md" || ["references", "scripts", "assets"].includes(components[0]!);
    const forbidden = components.some(
      (part) =>
        part.startsWith(".") ||
        ["node_modules", "target", "dist", "build", "__pycache__"].includes(part),
    );
    const lower = relative.toLowerCase();
    const basename = path.basename(relative).toLowerCase();
    const privateFile =
      ["credential", "telemetry", "session"].some((marker) => lower.includes(marker)) ||
      lower.endsWith(".env") ||
      lower.endsWith("state.db") ||
      ["token", "secret"].some((marker) => basename.includes(marker)) ||
      basename.endsWith(".pem") ||
      basename.endsWith(".key");
    if (
      !this.#inside(file, root) ||
      !supported ||
      forbidden ||
      privateFile ||
      (await this.#isLink(path.join(root, relative)))
    )
      throw new Error("Skill resource is private, unsafe, or outside the package");
    const metadata = await fs.stat(file);
    if (!metadata.isFile() || metadata.size > MAX_PREVIEW_BYTES)
      throw new Error("Skill resource exceeds the preview limit");
    return { path: relative.replaceAll("\\", "/"), content: await fs.readFile(file, "utf8") };
  }

  async #prepare(
    source: Source,
    operation: "install" | "update",
    existingName?: string,
    changeRef = false,
  ) {
    await this.#expirePreviews();
    if (
      !source ||
      typeof source.repository !== "string" ||
      typeof source.ref !== "string" ||
      typeof source.path !== "string"
    )
      throw new Error("Invalid Skill source");
    const [owner, repository, extra] = source.repository.split("/");
    if (!owner || !repository || extra !== undefined)
      throw new Error("Skill repository must include an owner and repository");
    this.#validateRepoSegment(owner);
    this.#validateRepoSegment(repository);
    if (source.ref_type) this.#selector({ type: source.ref_type, value: source.ref });
    this.#validateRepoPath(source.path);
    if (operation === "install") {
      const existing = this.#findRemotePackage(await this.#lock(), source);
      if (existing) {
        if (!this.#sameSource(existing[1].source!, source))
          throw new Error(
            "This Skill is already installed from another ref; use Change version to switch its tag, branch, or commit",
          );
        operation = "update";
        existingName = existing[0];
      }
    }
    const selected = await this.#resolve({
      owner,
      repository,
      selectorPath: source.path,
      reference: source.ref,
      referenceType: source.ref_type,
    });
    const prefix = source.path ? `${source.path.replace(/\/$/, "")}/` : "";
    const files = selected.entries.filter(
      (entry) => entry.type === "blob" && (prefix ? entry.path.startsWith(prefix) : true),
    );
    if (!files.some((entry) => entry.path === `${prefix}SKILL.md`))
      throw new Error("Selected Skill path no longer contains SKILL.md");
    if (files.length > MAX_SKILL_FILES) throw new Error("Skill package exceeds the 512 file limit");
    const portablePaths = new Set(
      files.map((entry) => portableSkillPath(entry.path.slice(prefix.length))),
    );
    if (portablePaths.size !== files.length)
      throw new Error("Skill package contains paths that collide on case-insensitive filesystems");
    let total = 0;
    for (const entry of files) {
      if (entry.mode !== "100644" && entry.mode !== "100755")
        throw new Error(`Skill package contains an unsupported file: ${entry.path}`);
      const relative = entry.path.slice(prefix.length);
      this.#validateRelative(relative);
      const components = relative.split("/");
      for (let index = 0; index < components.length - 1; index++) {
        if (portablePaths.has(portableSkillPath(components.slice(0, index + 1).join("/"))))
          throw new Error(`Skill package has a file-directory collision: ${relative}`);
      }
      const size = entry.size ?? 0;
      if (size > MAX_FILE_BYTES)
        throw new Error(`Skill file exceeds the 8 MiB limit: ${entry.path}`);
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new Error("Skill package exceeds the 32 MiB limit");
    }
    const tempPath = await this.#staging();
    const packagePath = path.join(tempPath, "package");
    try {
      await fs.mkdir(packagePath);
      const downloaded = await mapConcurrent(files, 8, async (entry) => {
        const relative = entry.path.slice(prefix.length);
        this.#validateRelative(relative);
        const target = path.join(packagePath, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const bytes = await this.#raw(
          owner,
          repository,
          selected.commit,
          entry.path,
          MAX_FILE_BYTES,
        );
        if (bytes.length !== (entry.size ?? 0))
          throw new Error(`GitHub file size changed during download: ${entry.path}`);
        await fs.writeFile(target, bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
        return {
          path: relative.replaceAll("\\", "/"),
          size: bytes.length,
          executable: entry.mode === "100755",
        } satisfies FileEntry;
      });
      const metadata = this.#frontmatter(
        await fs.readFile(path.join(packagePath, "SKILL.md"), "utf8"),
      );
      this.#validateSkillName(metadata.name);
      const lock = await this.#lock();
      if (operation === "install" && this.#findRemotePackage(lock, source))
        throw new Error(
          "Skill source was installed while preparing the preview; prepare the operation again",
        );
      const name =
        existingName ??
        this.#allocateName(
          metadata.name,
          `${source.repository.toLowerCase()}:${source.path}:${source.ref_type ?? ""}:${source.ref}`,
          await this.#reservedNames(lock),
        );
      const target = path.join(this.root, "skills", name);
      const previousHash = await this.#targetHash(target);
      if (operation === "install" && previousHash)
        throw new Error("A Skill with this name already exists");
      if (operation === "update" && !previousHash)
        throw new Error("Installed Skill does not exist");
      const currentLock = lock.skills[name];
      if (operation === "update" && !currentLock)
        throw new Error("Unmanaged Skills cannot be updated");
      if (
        operation === "update" &&
        (!currentLock?.source ||
          (changeRef
            ? currentLock.source.repository.toLowerCase() !== source.repository.toLowerCase() ||
              currentLock.source.path !== source.path
            : !this.#sameSource(currentLock.source, source)))
      )
        throw new Error("Skill update source changed");
      if (
        existingName &&
        metadata.name !==
          (currentLock?.upstream_display_name ??
            currentLock?.display_name ??
            existingName.split("--")[0])
      )
        throw new Error("Skill update changed the package name");
      const beforePath = previousHash === null ? null : path.join(tempPath, "before");
      if (beforePath) {
        await copySkillPackage(target, beforePath);
        if (
          (await this.#packageHash(beforePath)).hash !== previousHash ||
          (await this.#targetHash(target)) !== previousHash
        )
          throw new Error("Installed Skill changed while preparing the preview");
      }
      const [added, modified, removed] = await this.#fileDelta(
        beforePath ?? path.join(tempPath, "before"),
        packagePath,
      );
      const packageResult = await this.#packageHash(packagePath);
      const resolvedSource: Source = {
        kind:
          owner.toLowerCase() === "openai" &&
          repository.toLowerCase() === "skills" &&
          source.path.startsWith("skills/.curated/")
            ? "openai-curated"
            : "github",
        repository: `${owner}/${repository}`,
        ref: source.ref_type === "commit" ? selected.commit : selected.reference,
        ...(selected.referenceType ? { ref_type: selected.referenceType } : {}),
        path: source.path,
        resolved_commit: selected.commit,
        tree_sha:
          selected.entries.find((entry) => entry.type === "tree" && entry.path === source.path)
            ?.sha ?? selected.rootTree,
      };
      const now = new Date().toISOString();
      const token = randomUUID();
      const preview = {
        token,
        operation,
        library_id: name,
        ...(operation === "update" ? { previous_source: currentLock?.source ?? null } : {}),
        skill: { ...metadata, source: resolvedSource },
        files: downloaded.sort((a, b) => a.path.localeCompare(b.path)),
        added,
        modified,
        removed,
        total_size: packageResult.size,
        local_modified: Boolean(
          currentLock &&
          (previousHash !== currentLock.content_sha256 ||
            (currentLock.source &&
              currentLock.content_sha256 !==
                (currentLock.upstream_base_hash ?? currentLock.content_sha256))),
        ),
        expires_at: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      };
      const entry: LockEntry = {
        ...currentLock,
        source: resolvedSource,
        content_sha256: packageResult.hash,
        upstream_base_hash: packageResult.hash,
        upstream_display_name: metadata.name,
        installed_at: currentLock?.installed_at ?? now,
        updated_at: now,
        display_name: metadata.name,
      };
      await this.#remember({
        preview,
        name,
        packagePath,
        tempPath,
        lock: entry,
        expectedHash: previousHash,
        expectedLock: this.#lockFingerprint(currentLock),
        beforePath,
        stagedBytes:
          packageResult.size + (beforePath ? (await this.#packageHash(beforePath)).size : 0),
      });
      return preview;
    } catch (error) {
      activePreviewDirectories.delete(tempPath);
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  async #parseUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error("Enter a valid GitHub URL");
    }
    if (
      url.protocol !== "https:" ||
      !["github.com", "www.github.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Only public github.com HTTPS URLs are supported");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (parts.length < 2) throw new Error("GitHub URL must include an owner and repository");
    const owner = parts[0]!;
    const repository = parts[1]!.replace(/\.git$/, "");
    this.#validateRepoSegment(owner);
    this.#validateRepoSegment(repository);
    let selectorPath = "";
    let reference: string | undefined;
    if (parts.length > 2) {
      if (!["tree", "blob"].includes(parts[2]!) || parts.length < 4)
        throw new Error("GitHub URL must point to a repository, tree, or SKILL.md blob");
      const selector = parts[2]!;
      const remainder = parts.slice(3);
      if (selector === "blob" && remainder.at(-1) !== "SKILL.md")
        throw new Error("GitHub blob URL must point to SKILL.md");
      let resolved = false;
      for (
        let split = 1;
        split <= Math.min(8, remainder.length - (selector === "blob" ? 1 : 0));
        split++
      ) {
        const candidateRef = remainder.slice(0, split).join("/");
        try {
          await this.#commit(owner, repository, candidateRef);
          reference = candidateRef;
          selectorPath = remainder
            .slice(split)
            .join("/")
            .replace(/\/?SKILL\.md$/, "");
          resolved = true;
          break;
        } catch {
          /* A tree URL can contain a slash in its ref. */
        }
      }
      if (!resolved) throw new Error("Could not resolve the GitHub URL reference");
      this.#validateRepoPath(selectorPath);
    }
    return { owner, repository, selectorPath, reference };
  }

  async #resolve(input: {
    owner: string;
    repository: string;
    selectorPath: string;
    reference?: string;
    referenceType?: VersionSelector["type"];
  }) {
    const repo = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
    )) as { default_branch?: string };
    const reference = input.reference ?? repo.default_branch;
    const referenceType =
      input.referenceType ?? (input.reference === undefined ? "branch" : undefined);
    if (!reference) throw new Error("Could not determine the GitHub default branch");
    const commit = await this.#commit(input.owner, input.repository, reference, referenceType);
    const commitResponse = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(commit)}`,
    )) as { commit?: { tree?: { sha?: string } } };
    const rootTree = commitResponse.commit?.tree?.sha;
    if (!rootTree) throw new Error("GitHub commit has no root tree");
    const response = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/trees/${rootTree}?recursive=1`,
    )) as { tree?: TreeEntry[]; truncated?: boolean };
    if (
      response.truncated ||
      !Array.isArray(response.tree) ||
      response.tree.length > MAX_TREE_ENTRIES
    )
      throw new Error("GitHub repository tree exceeds the inspection limit");
    if (
      input.selectorPath &&
      !response.tree.some((entry) => entry.type === "tree" && entry.path === input.selectorPath)
    )
      throw new Error("Selected GitHub directory does not exist");
    const entries = response.tree.filter(
      (entry) =>
        !input.selectorPath ||
        entry.path === input.selectorPath ||
        entry.path.startsWith(`${input.selectorPath}/`),
    );
    return {
      owner: input.owner,
      repository: input.repository,
      reference,
      referenceType,
      commit,
      rootTree,
      selectorPath: input.selectorPath,
      entries,
    };
  }

  async #commit(
    owner: string,
    repository: string,
    reference: string,
    type?: VersionSelector["type"],
  ) {
    const selector =
      type === "tag" ? `tags/${reference}` : type === "branch" ? `heads/${reference}` : reference;
    const response = (await this.#json(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(selector)}`,
    )) as { sha?: string };
    if (!response.sha || !/^[a-f0-9]{40}$/i.test(response.sha))
      throw new Error("GitHub reference did not resolve to a commit");
    return response.sha;
  }

  async #raw(owner: string, repository: string, commit: string, file: string, maxBytes: number) {
    const task = currentTask();
    task?.checkpoint();
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(commit)}/${file.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, {
      signal: task
        ? AbortSignal.any([task.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: { "User-Agent": "agentkib-skill-hub" },
    });
    if (!response.ok) throw new Error(`GitHub download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("GitHub file exceeds the download limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error("GitHub file exceeds the download limit");
    return data;
  }

  async #json(url: string) {
    const task = currentTask();
    task?.checkpoint();
    const response = await fetch(url, {
      signal: task
        ? AbortSignal.any([task.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentkib-skill-hub" },
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > 32 * 1024 * 1024)
      throw new Error("GitHub response exceeds the 32 MiB limit");
    return JSON.parse(data.toString("utf8")) as unknown;
  }

  #frontmatter(
    content: string,
    fallbackName?: string,
    validateDeclaredName = false,
  ): SkillMetadata {
    if (Buffer.byteLength(content) > MAX_ENTRY_BYTES)
      throw new Error("SKILL.md exceeds the 1 MiB limit");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
    const value = parseYaml(match[1]!);
    if (!value || typeof value !== "object") throw new Error("Skill frontmatter must be a mapping");
    const declaredName = Object.hasOwn(value, "name");
    const name = declaredName ? value.name : fallbackName;
    const description = value.description;
    if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 64)
      throw new Error("Skill name is invalid");
    if (
      typeof description !== "string" ||
      !description.trim() ||
      Buffer.byteLength(description) > 1024
    )
      throw new Error("Skill description is invalid");
    if (declaredName && validateDeclaredName) this.#validateSkillName(name.trim());
    return {
      name: declaredName ? name.trim() : name,
      description: description.trim(),
      license: typeof value.license === "string" ? value.license : null,
      compatibility: typeof value.compatibility === "string" ? value.compatibility : null,
    };
  }

  async #packageHash(root: string) {
    const info = await skillPackage(root).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Skill package exceeds the file limit")
        throw new Error("Skill package contains a file larger than 8 MiB or too many files");
      throw error;
    });
    if (info.diagnostics.length)
      throw new Error(
        `Skill package contains unsupported resources: ${info.diagnostics.join("; ")}`,
      );
    return { hash: info.hash, size: info.totalSize, modifiedAt: info.modifiedAt };
  }

  async #fileDelta(existing: string, incoming: string) {
    const collect = async (root: string) => {
      const files = new Map<string, string>();
      if (
        !(await fs.stat(root).then(
          (value) => value.isDirectory(),
          () => false,
        ))
      )
        return files;
      const packageInfo = await skillPackage(root);
      if (packageInfo.diagnostics.length) throw new Error(packageInfo.diagnostics.join("; "));
      for (const entry of packageInfo.files)
        files.set(entry.path, `${entry.sha256}:${entry.executable}`);
      return files;
    };
    const [before, after] = await Promise.all([collect(existing), collect(incoming)]);
    return [
      [...after.keys()].filter((key) => !before.has(key)).sort(),
      [...after.keys()]
        .filter((key) => before.has(key) && before.get(key) !== after.get(key))
        .sort(),
      [...before.keys()].filter((key) => !after.has(key)).sort(),
    ];
  }

  async #annotate(snapshot: {
    entries?: Array<{ candidate: Candidate; installed?: boolean }>;
    cached_at?: string;
    stale?: boolean;
  }) {
    const names = new Set((await this.installed()).map((skill) => skill.display_name));
    return {
      entries: (snapshot.entries ?? []).map((entry) => ({
        ...entry.candidate,
        installed: names.has(entry.candidate.name),
      })),
      cached_at: snapshot.cached_at ?? new Date().toISOString(),
      stale: snapshot.stale === true,
    };
  }

  async #displayName(root: string, fallback: string) {
    try {
      return this.#frontmatter(await fs.readFile(path.join(root, "SKILL.md"), "utf8")).name;
    } catch {
      return fallback;
    }
  }

  async #lock(): Promise<LockFile> {
    const lock = (await this.#readJson(path.join(this.root, "skills.lock.json")).catch(
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)),
    )) as Partial<LockFile> | null;
    if (!lock) return { schema_version: 1, skills: {}, previous: {} };
    if (lock.schema_version !== 1 && lock.schema_version !== 2)
      throw new Error("Unsupported Skill lock schema version");
    return {
      schema_version: lock.schema_version,
      skills: lock.skills ?? {},
      previous: lock.previous ?? {},
    };
  }

  async #readJson(file: string) {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  }
  async #writeJson(file: string, value: unknown) {
    await writeSkillJson(file, value);
  }
  async #isLink(file: string) {
    return fs.lstat(file).then(
      (info) => info.isSymbolicLink(),
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : Promise.reject(error)),
    );
  }
  #inside(value: string, root: string) {
    const relative = path.relative(root, value);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }
  #validateId(name: string) {
    if (
      !name ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".." ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error("Skill library identifier is invalid");
  }
  #validateSkillName(name: string) {
    if (
      !name ||
      name.length > 64 ||
      !/^[a-z0-9-]+$/.test(name) ||
      !/^[a-z0-9]/.test(name) ||
      !/[a-z0-9]$/.test(name) ||
      name.includes("--")
    )
      throw new Error("Skill name must use lowercase letters, numbers, and single hyphens");
  }
  #validateRelative(value: string) {
    if (
      !value ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Skill package contains an unsafe path");
  }
  #validateRepoSegment(value: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..")
      throw new Error("GitHub URL contains an invalid repository path");
  }
  #validateRepoPath(value: string) {
    if (
      value &&
      (value.startsWith("/") ||
        value.includes("\\") ||
        value.split("/").some((part) => !part || part === ".." || part === "."))
    )
      throw new Error("GitHub repository path is unsafe");
  }
  #findRemotePackage(lock: LockFile, source: Source) {
    return Object.entries(lock.skills).find(
      ([, record]) =>
        record.source &&
        record.source.repository.toLowerCase() === source.repository.toLowerCase() &&
        record.source.path === source.path,
    );
  }
  #sameSource(a: Source, b: Source) {
    return (
      a.repository.toLowerCase() === b.repository.toLowerCase() &&
      a.ref === b.ref &&
      a.ref_type === b.ref_type &&
      a.path === b.path
    );
  }
  #string(value: unknown, name: string) {
    if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
    return value;
  }
}
