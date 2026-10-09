import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { FileChange } from "./change-plan";
import { McpRedactionBudget, mcpTextPrivateValues, redactMcpText } from "./mcp-import";

const PRIVATE_MAP = /^(env|environment|headers|http_headers)$/i;
const PRIVATE_FIELD =
  /(token|password|secret|api[_-]?key|authorization|credential|oauth)|^(key|auth|accesskey|signature|sig)$/i;

function privateArgument(entries: unknown[], index: number): boolean {
  const previous = entries[index - 1];
  return (
    typeof entries[index] === "string" &&
    index > 0 &&
    typeof previous === "string" &&
    !previous.includes("=") &&
    /^-.*(?:token|password|secret|key|auth|signature|sig$)/i.test(previous)
  );
}

function parseSnapshot(content: string, validator: string): unknown {
  if (!content.trim()) return undefined;
  return validator === "toml"
    ? parseToml(content)
    : validator === "yaml"
      ? parseYaml(content)
      : JSON5.parse(content);
}

/** Private snapshots remain in the host; only these derived previews reach the renderer. */
export function publicMcpMigrationChanges(
  changes: readonly FileChange[],
): Pick<FileChange, "target" | "scope" | "before" | "after">[] {
  const snapshots = changes.map((change) => ({
    change,
    before: parseSnapshot(change.before, change.validator),
    after: parseSnapshot(change.after, change.validator),
  }));
  const budget = new McpRedactionBudget(),
    secrets = new Set<string>(),
    ancestors = new Set<object>();
  const collect = (item: unknown, privateValue = false): void => {
    if (typeof item === "string") {
      if (privateValue && item) {
        secrets.add(item);
        budget.checkSecretCount(secrets.size);
      }
      for (const value of mcpTextPrivateValues(item, budget)) {
        secrets.add(value);
        budget.checkSecretCount(secrets.size);
      }
      return;
    }
    if (item === null || typeof item !== "object") return;
    if (ancestors.has(item))
      throw new Error("Cyclic native configuration cannot be safely previewed");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        item.forEach((entry, index) =>
          collect(entry, privateValue || privateArgument(item, index)),
        );
      } else {
        for (const [key, entry] of Object.entries(item))
          collect(entry, privateValue || PRIVATE_MAP.test(key) || PRIVATE_FIELD.test(key));
      }
    } finally {
      ancestors.delete(item);
    }
  };
  // A removed field can be the only evidence that text repeated elsewhere is
  // private. Collect from every before/after snapshot before rendering either side.
  for (const { before, after } of snapshots) {
    collect(before);
    collect(after);
  }
  const secretValues = [...secrets].sort((a, b) => b.length - a.length),
    mask = (value: string) => redactMcpText(value, secretValues, budget);
  const scrub = (item: unknown, key = ""): unknown => {
    if (PRIVATE_MAP.test(key) && item && typeof item === "object")
      return Object.fromEntries(Object.keys(item).map((name) => [mask(name), "[redacted]"]));
    if (PRIVATE_FIELD.test(key)) return "[redacted]";
    if (Array.isArray(item))
      return item.map((entry, index) =>
        privateArgument(item, index) ? "[redacted]" : scrub(entry, key),
      );
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([name, entry]) => [mask(name), scrub(entry, name)]),
      );
    return typeof item === "string" ? mask(item) : item;
  };
  const preview = (value: unknown): string =>
    value === undefined ? "" : JSON.stringify(scrub(value), null, 2);
  return snapshots.map(({ change, before, after }) => ({
    target: change.target,
    scope: change.scope,
    before: preview(before),
    after: preview(after),
  }));
}
