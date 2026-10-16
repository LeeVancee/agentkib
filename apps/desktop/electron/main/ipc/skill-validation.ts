import type {
  PrepareSkillDeploymentRequest,
  SkillDetailRequest,
  SkillSource,
  SkillVersionSelector,
  SkillVersionListRequest,
} from "../../../src/core/types";
import { requireObject, requireString } from "./validation";
import type {
  PrepareSkillSyncRequest,
  SaveSkillSyncPolicyRequest,
  SkillSyncPolicy,
} from "@agentkib/runtime-protocol";
import { requireBoolean } from "./validation";

function fields(value: unknown, allowed: string[]) {
  const input = requireObject(value, "Skill request");
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new TypeError("Unexpected Skill request field");
  return input;
}

export function skillIdentity(value: unknown, label: string) {
  const id = requireString(value, label);
  if (id.length > 1024 || id.includes("\0")) throw new TypeError(`Invalid ${label}`);
  return id;
}

export function skillRelativePath(value: unknown) {
  const path = requireString(value, "path");
  if (
    path.length > 4096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    // Drive-relative names are unsafe on Windows, but colons are literal filenames on Unix.
    (process.platform === "win32" && /^[a-z]:/i.test(path)) ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new TypeError("Skill path must remain inside its package");
  return path;
}

export function skillDetailRequest(
  value: unknown,
  withFile = false,
): SkillDetailRequest & { path?: string } {
  const input = fields(
    value,
    withFile ? ["library_id", "observation_id", "path"] : ["library_id", "observation_id"],
  );
  const library = input.library_id !== undefined;
  const observation = input.observation_id !== undefined;
  if (library === observation) throw new TypeError("Select exactly one Skill identity");
  return {
    ...(library
      ? { library_id: skillIdentity(input.library_id, "library_id") }
      : { observation_id: skillIdentity(input.observation_id, "observation_id") }),
    ...(withFile ? { path: skillRelativePath(input.path) } : {}),
  };
}

export function skillObservationIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 4096)
    throw new TypeError("Select between 1 and 4096 Skill observations");
  const ids = value.map((id) => skillIdentity(id, "observation_id"));
  if (new Set(ids).size !== ids.length) throw new TypeError("Duplicate Skill observation");
  return ids;
}

export function skillVersionSelector(value: unknown): SkillVersionSelector {
  const input = fields(value, ["type", "value"]);
  if (input.type !== "tag" && input.type !== "branch" && input.type !== "commit")
    throw new TypeError("Unsupported Skill version type");
  const reference = skillIdentity(input.value, "version reference");
  if (
    [...reference].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    (input.type === "commit" && !/^[a-f0-9]{7,40}$/i.test(reference))
  )
    throw new TypeError("Invalid Skill version reference");
  return { type: input.type, value: reference };
}

export function skillSource(value: unknown): SkillSource {
  const input = fields(value, [
    "kind",
    "repository",
    "ref",
    "ref_type",
    "path",
    "resolved_commit",
    "tree_sha",
  ]);
  if (input.kind !== "github" && input.kind !== "openai-curated")
    throw new TypeError("Unsupported Skill source");
  const repository = skillIdentity(input.repository, "repository");
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository))
    throw new TypeError("Skill repository must include an owner and repository");
  const ref = skillIdentity(input.ref, "ref");
  const selector =
    input.ref_type === undefined
      ? undefined
      : skillVersionSelector({ type: input.ref_type, value: ref });
  return {
    kind: input.kind,
    repository,
    ref,
    ...(selector ? { ref_type: selector.type } : {}),
    path: input.path === "" ? "" : skillRelativePath(input.path),
    resolved_commit: skillIdentity(input.resolved_commit, "resolved_commit"),
    tree_sha: skillIdentity(input.tree_sha, "tree_sha"),
  };
}

export function skillVersionListRequest(value: unknown): SkillVersionListRequest {
  const input = fields(value, ["library_id", "source", "type", "page"]);
  if (input.type !== "tag" && input.type !== "branch")
    throw new TypeError("Select tag or branch versions");
  if ((input.library_id !== undefined) === (input.source !== undefined))
    throw new TypeError("Select exactly one Skill source");
  const page = input.page ?? 1;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 10_000)
    throw new TypeError("Invalid Skill version page");
  return {
    ...(input.library_id === undefined
      ? { source: skillSource(input.source) }
      : { library_id: skillIdentity(input.library_id, "library_id") }),
    type: input.type,
    page,
  };
}

export function skillDeploymentRequest(value: unknown): PrepareSkillDeploymentRequest {
  const input = fields(value, ["operation", "library_id", "deployment_id", "target_ids"]);
  if (input.operation === "deploy") {
    if (
      input.deployment_id !== undefined ||
      !Array.isArray(input.target_ids) ||
      !input.target_ids.length ||
      input.target_ids.length > 256
    )
      throw new TypeError("A deployment requires a library Skill and selected targets");
    const target_ids = input.target_ids.map((id) => skillIdentity(id, "target_id"));
    if (new Set(target_ids).size !== target_ids.length)
      throw new TypeError("Duplicate Skill target");
    return {
      operation: "deploy",
      library_id: skillIdentity(input.library_id, "library_id"),
      target_ids,
    };
  }
  if (
    !["update", "undeploy", "rollback"].includes(String(input.operation)) ||
    input.library_id !== undefined ||
    input.target_ids !== undefined
  )
    throw new TypeError("Unsupported Skill deployment operation");
  return {
    operation: input.operation as "update" | "undeploy" | "rollback",
    deployment_id: skillIdentity(input.deployment_id, "deployment_id"),
  };
}

export function skillSyncRequest(value: unknown): PrepareSkillSyncRequest {
  const input = fields(value, [
    "operation",
    "deployment_id",
    "observation_id",
    "library_id",
    "resolution",
  ]);
  if (
    !["adopt", "pull", "push", "fork", "detach", "restore", "bind"].includes(
      String(input.operation),
    )
  )
    throw new TypeError("Unsupported Skill synchronization operation");
  if (
    input.resolution !== undefined &&
    input.resolution !== "library" &&
    input.resolution !== "deployment"
  )
    throw new TypeError("Invalid Skill conflict resolution");
  const result: PrepareSkillSyncRequest = {
    operation: input.operation as PrepareSkillSyncRequest["operation"],
  };
  for (const key of ["deployment_id", "observation_id", "library_id"] as const)
    if (input[key] !== undefined) result[key] = skillIdentity(input[key], key);
  if (input.resolution !== undefined) result.resolution = input.resolution;
  return result;
}

export function skillSyncPolicyRequest(
  value: unknown,
): SaveSkillSyncPolicyRequest & { confirmed: true } {
  const input = fields(value, ["policy", "revision", "approve_home"]);
  const policy = fields(input.policy, [
    "schema_version",
    "revision",
    "enabled",
    "interval_hours",
    "default_mode",
    "libraries",
    "deployments",
    "updated_at",
  ]);
  const revision = (value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError("Invalid Skill policy revision");
    return value;
  };
  if (policy.schema_version !== 1 || !["check", "manual"].includes(String(policy.default_mode)))
    throw new TypeError("Invalid Skill synchronization policy");
  if (typeof policy.interval_hours !== "number" || ![0, 1, 6, 24].includes(policy.interval_hours))
    throw new TypeError("Skill synchronization interval must be 0, 1, 6 or 24 hours");
  const libraries: SkillSyncPolicy["libraries"] = {};
  const deployments: SkillSyncPolicy["deployments"] = {};
  const libraryInput = requireObject(policy.libraries, "libraries");
  const deploymentInput = requireObject(policy.deployments, "deployments");
  if (Object.keys(libraryInput).length > 4096 || Object.keys(deploymentInput).length > 4096)
    throw new TypeError("Too many Skill synchronization policies");
  for (const [id, value] of Object.entries(libraryInput)) {
    skillIdentity(id, "library_id");
    if (["__proto__", "constructor", "prototype"].includes(id))
      throw new TypeError("Invalid Skill policy identity");
    const entry = fields(value, ["mode", "owner_key", "source_key"]);
    if (!["manual", "check", "auto_update"].includes(String(entry.mode)))
      throw new TypeError("Invalid Skill library policy");
    libraries[id] = {
      mode: entry.mode as "manual" | "check" | "auto_update",
      ...(entry.owner_key === undefined
        ? {}
        : { owner_key: skillIdentity(entry.owner_key, "owner_key") }),
      ...(entry.source_key === undefined
        ? {}
        : { source_key: skillIdentity(entry.source_key, "source_key") }),
    };
    if (entry.mode === "auto_update" && (!entry.owner_key || !entry.source_key))
      throw new TypeError("Automatic Skill updates require a verified source identity");
  }
  for (const [id, value] of Object.entries(deploymentInput)) {
    skillIdentity(id, "deployment_id");
    if (["__proto__", "constructor", "prototype"].includes(id))
      throw new TypeError("Invalid Skill policy identity");
    const entry = fields(value, ["mode", "approve_home", "owner_key", "target_key"]);
    if (!["manual", "follow", "pinned"].includes(String(entry.mode)))
      throw new TypeError("Invalid Skill deployment policy");
    deployments[id] = {
      mode: entry.mode as "manual" | "follow" | "pinned",
      approve_home: requireBoolean(entry.approve_home, "approve_home"),
      owner_key: skillIdentity(entry.owner_key, "owner_key"),
      target_key: skillIdentity(entry.target_key, "target_key"),
    };
  }
  if (
    policy.updated_at !== null &&
    (typeof policy.updated_at !== "string" || !Number.isFinite(Date.parse(policy.updated_at)))
  )
    throw new TypeError("Invalid Skill policy timestamp");
  return {
    confirmed: true,
    revision: revision(input.revision),
    approve_home:
      input.approve_home === undefined ? false : requireBoolean(input.approve_home, "approve_home"),
    policy: {
      schema_version: 1,
      revision: revision(policy.revision),
      enabled: requireBoolean(policy.enabled, "enabled"),
      interval_hours: policy.interval_hours,
      default_mode: policy.default_mode as "check" | "manual",
      libraries,
      deployments,
      updated_at: policy.updated_at as string | null,
    },
  };
}
