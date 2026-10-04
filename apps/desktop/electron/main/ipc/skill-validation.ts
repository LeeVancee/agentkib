import type { PrepareSkillDeploymentRequest, SkillDetailRequest } from "../../../src/core/types";
import { requireObject, requireString } from "./validation";

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
