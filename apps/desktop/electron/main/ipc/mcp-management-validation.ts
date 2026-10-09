import {
  optionalString,
  requireAgentKind,
  requireBoolean,
  requireObject,
  requireString,
} from "./validation";

function object(value: unknown, keys: string[]) {
  const input = requireObject(value, "MCP request");
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new TypeError("Unsupported MCP request field");
  return input;
}
function strings(value: unknown, name: string, maximum = 256) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`Invalid ${name}`);
  return value.map((item) => requireString(item, name));
}
export function mcpScope(value: unknown) {
  const input = object(value, ["project"]);
  return { project: optionalString(input.project, "project") };
}
export function mcpSave(value: unknown) {
  const input = object(value, [
    "project",
    "revision",
    "server",
    "secretOperations",
    "overrideInherited",
    "originalId",
  ]);
  const server = requireObject(input.server, "server");
  if (JSON.stringify(server).length > 1024 * 1024)
    throw new TypeError("MCP configuration is too large");
  const secretOperations: Record<string, Record<string, unknown>> = {};
  if (input.secretOperations !== undefined) {
    const groups = object(input.secretOperations, ["env", "headers"]);
    for (const [group, entries] of Object.entries(groups)) {
      const checked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(requireObject(entries, group))) {
        if (!key.trim() || key.length > 256) throw new TypeError("Invalid secret key");
        const op = object(value, ["action", "value"]);
        if (!["keep", "replace", "delete"].includes(String(op.action)))
          throw new TypeError("Invalid secret operation");
        if (op.action === "replace" && (typeof op.value !== "string" || op.value.length > 65536))
          throw new TypeError("Invalid secret value");
        if (op.action !== "replace" && op.value !== undefined)
          throw new TypeError("Unexpected secret value");
        checked[key] = op;
      }
      secretOperations[group] = checked;
    }
  }
  return {
    project: optionalString(input.project, "project"),
    revision: requireString(input.revision, "revision"),
    server,
    secretOperations,
    originalId: optionalString(input.originalId, "originalId"),
    overrideInherited:
      input.overrideInherited === undefined
        ? false
        : requireBoolean(input.overrideInherited, "overrideInherited"),
  };
}
export function mcpRemove(value: unknown) {
  const input = object(value, ["project", "revision", "id"]);
  return {
    project: optionalString(input.project, "project"),
    revision: requireString(input.revision, "revision"),
    id: requireString(input.id, "id"),
  };
}
export function mcpImportPreview(value: unknown) {
  const input = object(value, ["project", "text", "candidateIds"]);
  if ((input.text === undefined) === (input.candidateIds === undefined))
    throw new TypeError("Select one import source");
  if (
    input.text !== undefined &&
    (typeof input.text !== "string" || input.text.length > 1024 * 1024)
  )
    throw new TypeError("Invalid MCP import text");
  return {
    project: optionalString(input.project, "project"),
    ...(input.text !== undefined
      ? { text: input.text }
      : { candidateIds: strings(input.candidateIds, "candidateIds") }),
  };
}
export function mcpImportApply(value: unknown) {
  const input = object(value, ["project", "token", "revision", "selections"]);
  if (!Array.isArray(input.selections) || input.selections.length > 256)
    throw new TypeError("Invalid selections");
  const selections = input.selections.map((value) => {
    const item = object(value, ["key", "action", "id"]);
    if (!["add", "replace", "skip"].includes(String(item.action)))
      throw new TypeError("Invalid import action");
    return {
      key: requireString(item.key, "key"),
      action: item.action,
      id: optionalString(item.id, "id"),
    };
  });
  return {
    project: optionalString(input.project, "project"),
    token: requireString(input.token, "token"),
    revision: requireString(input.revision, "revision"),
    selections,
  };
}
export function mcpConnectionBatch(value: unknown) {
  const input = object(value, ["workspaceId", "targetAgents", "all", "rebindAgents"]);
  return {
    workspaceId: requireString(input.workspaceId, "workspaceId"),
    ...(input.all === undefined ? {} : { all: requireBoolean(input.all, "all") }),
    ...(input.targetAgents === undefined
      ? {}
      : { targetAgents: strings(input.targetAgents, "targetAgents").map(requireAgentKind) }),
    ...(input.rebindAgents === undefined
      ? {}
      : { rebindAgents: strings(input.rebindAgents, "rebindAgents").map(requireAgentKind) }),
  };
}
export function mcpConnectionApply(value: unknown) {
  const input = object(value, ["token", "approveHome"]);
  return {
    token: requireString(input.token, "token"),
    approveHome: requireBoolean(input.approveHome, "approveHome"),
  };
}
export function mcpPolicySave(value: unknown) {
  const input = object(value, ["project", "revision", "rules"]);
  if (!Array.isArray(input.rules) || input.rules.length > 8192)
    throw new TypeError("Invalid policy rules");
  const rules = input.rules.map((value) => {
    const rule = object(value, ["agent", "server_id", "mode", "tools"]);
    if (!["inherit", "all", "selected"].includes(String(rule.mode)))
      throw new TypeError("Invalid policy mode");
    return {
      agent: requireAgentKind(rule.agent),
      server_id: rule.server_id === null ? null : requireString(rule.server_id, "server_id"),
      mode: rule.mode,
      tools: strings(rule.tools, "tools", 4096),
    };
  });
  return {
    project: optionalString(input.project, "project"),
    revision: requireString(input.revision, "revision"),
    rules,
  };
}

export function mcpMigrationPreview(value: unknown) {
  const input = object(value, ["project", "revision", "candidateIds"]);
  return {
    project: requireString(input.project, "project"),
    revision: requireString(input.revision, "revision"),
    candidateIds: strings(input.candidateIds, "candidateIds"),
  };
}
