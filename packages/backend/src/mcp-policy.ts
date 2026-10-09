import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyChanges } from "./change-apply";
import { hash, safeTarget } from "./doctor-files";
import { canonicalProject, readText } from "./files";
import { userHome } from "./mcp-config-read";
import { pathIdentity } from "./paths";
import { agentSchema } from "./rpc";

const toolName = z.string().min(1).max(512);
const ruleSchema = z
  .object({
    agent: agentSchema,
    // null is the AgentKib builtin group, never an upstream server ID.
    server_id: z.string().min(1).max(256).nullable(),
    mode: z.enum(["inherit", "all", "selected"]),
    tools: z.array(toolName).max(4096).default([]),
  })
  .strict();
const documentSchema = z
  .object({
    schema_version: z.literal(1),
    rules: z.array(ruleSchema).max(8192),
  })
  .strict();
export type McpToolPolicyRule = z.infer<typeof ruleSchema>;
export interface McpToolPolicyState {
  revision: string;
  rules: McpToolPolicyRule[];
  inherited_rules: McpToolPolicyRule[];
  effective_rules: McpToolPolicyRule[];
}

type Snapshot = { file: string; content: string | null };
function readSnapshot(root: string, name: string): Snapshot {
  const file = path.join(root, ".agentkib", name);
  if (!safeTarget(root, file)) throw new Error("MCP policy/config path is unsafe");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("MCP policy/config must be a regular file no larger than 1 MiB");
    return { file, content: readText(file, 1024 * 1024, false) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, content: null };
    throw error;
  }
}
function validatedRules(value: unknown): McpToolPolicyRule[] {
  const rules = documentSchema.parse(value).rules;
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = JSON.stringify([rule.agent, rule.server_id]);
    if (seen.has(key)) throw new Error("Duplicate MCP tool policy rule");
    seen.add(key);
    if (rule.mode !== "selected" && rule.tools.length)
      throw new Error("Only selected MCP tool rules may contain tool names");
    if (new Set(rule.tools).size !== rule.tools.length)
      throw new Error("Duplicate MCP tool name in policy");
  }
  return rules;
}
function parseRules(snapshot: Snapshot): McpToolPolicyRule[] {
  if (snapshot.content === null) return [];
  try {
    return validatedRules(JSON.parse(snapshot.content));
  } catch {
    throw new Error("Invalid MCP tool policy; repair its configuration before using tools");
  }
}
function policySnapshot(project: string | null, environment: NodeJS.ProcessEnv) {
  const global = canonicalProject(userHome(environment));
  const local = project === null ? null : canonicalProject(project);
  if (local && pathIdentity(local) === pathIdentity(global))
    throw new Error("Workspace MCP policy scope overlaps the global configuration directory");
  const roots = local ? [global, local] : [global];
  const snapshots = roots.flatMap((root) =>
    ["mcp.json", "mcp.local.json", "mcp-policy.json"].map((name) => readSnapshot(root, name)),
  );
  const globalRules = parseRules(snapshots[2]!);
  const rules = local ? parseRules(snapshots[5]!) : globalRules;
  const inherited_rules = local ? globalRules : [];
  const effective = new Map<string, McpToolPolicyRule>();
  for (const rule of [...inherited_rules, ...rules]) {
    if (rule.mode !== "inherit") effective.set(JSON.stringify([rule.agent, rule.server_id]), rule);
  }
  return {
    root: local ?? global,
    target: snapshots.at(-1)!,
    state: {
      revision: hash(JSON.stringify(snapshots)),
      rules,
      inherited_rules,
      effective_rules: [...effective.values()],
    } satisfies McpToolPolicyState,
  };
}
export function readMcpPolicy(
  project: string | null,
  environment: NodeJS.ProcessEnv,
): McpToolPolicyState {
  return policySnapshot(project, environment).state;
}
export function mcpToolAllowed(
  policy: McpToolPolicyState,
  agent: string,
  serverId: string | null,
  tool: string,
): boolean {
  const rule = policy.effective_rules.find(
    (item) => item.agent === agent && item.server_id === serverId,
  );
  return !rule || rule.mode === "all" || rule.mode === "inherit" || rule.tools.includes(tool);
}
export function requireContinuationToolPolicy(
  project: string,
  agent: string,
  environment: NodeJS.ProcessEnv,
): void {
  const policy = readMcpPolicy(project, environment);
  if (
    ["session_search", "session_read_chunk"].some(
      (tool) => !mcpToolAllowed(policy, agent, null, tool),
    )
  )
    throw new Error(
      "Long-history continuation requires the AgentKib session_search and session_read_chunk tools; the current tool policy disables them",
    );
}
export function saveMcpPolicy(
  value: unknown,
  project: string | null,
  environment: NodeJS.ProcessEnv,
  dataDir: string,
): McpToolPolicyState {
  const request = z
    .object({ revision: z.string().length(64), rules: z.array(ruleSchema).max(8192) })
    .strict()
    .parse(value);
  const rules = validatedRules({ schema_version: 1, rules: request.rules });
  const snapshot = policySnapshot(project, environment);
  if (request.revision !== snapshot.state.revision)
    throw new Error(
      "MCP configuration or inherited policy changed; reload before saving tool rules",
    );
  const after = `${JSON.stringify({ schema_version: 1, rules }, null, 2)}\n`;
  if (Buffer.byteLength(after) > 1024 * 1024) throw new Error("MCP tool policy exceeds 1 MiB");
  if (after !== snapshot.target.content)
    applyChanges(
      {
        id: randomUUID(),
        project_root: snapshot.root,
        created_at: new Date().toISOString(),
        requires_home_approval: false,
        changes: [
          {
            target: snapshot.target.file,
            scope: "application-data",
            before: snapshot.target.content ?? "",
            after,
            original_hash: snapshot.target.content === null ? null : hash(snapshot.target.content),
            risk: "low",
            validator: "json",
          },
        ],
      },
      path.join(dataDir, "mcp-policy-backups"),
      {
        approvedHome: [],
        protectedHome: [],
        approvedApplication: [snapshot.target.file],
        approveHome: false,
      },
    );
  return readMcpPolicy(project, environment);
}
