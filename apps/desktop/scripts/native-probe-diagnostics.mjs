import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Redact diagnostic copies only; execution arguments and native data keep their exact bytes. */
export function createNativeProbeDiagnostics({
  binaryPaths = [],
  binaryPlaceholder = "$CLI_BINARY",
  binaryDirectoryPlaceholder = binaryPlaceholder.replace(/_BINARY$/, "_INSTALL_DIR"),
  repository,
  evidenceDir,
  root,
  home,
  redactText = (value) => value,
}) {
  const replacements = new Map();
  const binaryDirectories = binaryPaths.flatMap((binary) => {
    if (typeof binary !== "string") return [];
    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(binary)) return [path.win32.dirname(binary)];
    return path.posix.isAbsolute(binary) ? [path.posix.dirname(binary)] : [];
  });
  for (const [input, placeholder] of [
    ...binaryPaths.map((binary) => [binary, binaryPlaceholder]),
    [repository, "$WORKTREE"],
    [evidenceDir, "$EVIDENCE_DIR"],
    [root, "$ISOLATED_ROOT"],
    [home, "$HOME"],
    ...binaryDirectories.map((directory) => [directory, binaryDirectoryPlaceholder]),
  ]) {
    if (typeof input !== "string") continue;
    const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(input);
    if (!windows && !path.posix.isAbsolute(input)) continue;
    const full = input.replace(/[\\/]+$/, "");
    // Never turn a drive or filesystem root into a replacement for every path.
    if (!full || /^[a-z]:$/i.test(full)) continue;
    const slash = full.replaceAll("\\", "/");
    const variants = new Set([full, slash]);
    if (!windows) variants.add(pathToFileURL(full).href);
    else if (slash.startsWith("//")) {
      const [host, ...segments] = slash.slice(2).split("/");
      variants.add("file://" + host + "/" + segments.map(encodeURIComponent).join("/"));
    } else
      variants.add(
        "file:///" + slash.split("/").map(encodeURIComponent).join("/").replace("%3A", ":"),
      );
    for (const variant of variants) {
      let encoded = variant;
      // RPC argument strings can themselves contain JSON (and escaped Windows paths).
      for (let depth = 0; depth < 3; depth++) {
        if (!replacements.has(encoded.toLowerCase()))
          replacements.set(encoded.toLowerCase(), placeholder);
        encoded = JSON.stringify(encoded).slice(1, -1);
      }
    }
  }
  const alternatives = [...replacements.keys()]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = alternatives.length
    ? new RegExp(
        "(?:" + alternatives.join("|") + ")(?=$|[\\\\/\\s\"'`<>()[\\]{},:;!?#\\u001b])",
        "gi",
      )
    : undefined;
  const text = (value) => {
    const raw = value instanceof Error ? (value.stack ?? value.message) : String(value);
    return redactText(
      pattern ? raw.replace(pattern, (match) => replacements.get(match.toLowerCase())) : raw,
    );
  };
  const sanitize = (value) => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value instanceof Error)
      return sanitize({
        ...value,
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
      });
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [text(key), sanitize(item)]),
      );
    return value;
  };
  const error = (value, seen = new WeakMap()) => {
    if (!(value instanceof Error)) return sanitize(value);
    if (seen.has(value)) return seen.get(value);
    const safe =
      value instanceof AggregateError
        ? new AggregateError([], text(value.message))
        : new Error(text(value.message));
    seen.set(value, safe);
    safe.name = text(value.name);
    for (const key of Object.getOwnPropertyNames(value)) {
      const item = value[key];
      const redacted =
        key === "cause"
          ? error(item, seen)
          : key === "errors" && Array.isArray(item)
            ? item.map((entry) => error(entry, seen))
            : sanitize(item);
      Object.defineProperty(safe, key, {
        configurable: true,
        enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? false,
        writable: true,
        value: redacted,
      });
    }
    return safe;
  };
  return {
    text,
    error,
    sanitize,
    writeText: (file, value) => fs.writeFile(file, text(value), { mode: 0o600 }),
    writeJson: (file, value) =>
      fs.writeFile(file, JSON.stringify(sanitize(value), null, 2) + "\n", { mode: 0o600 }),
    writeJsonLines: (file, values) =>
      fs.writeFile(file, values.map((value) => JSON.stringify(sanitize(value))).join("\n") + "\n", {
        mode: 0o600,
      }),
  };
}
