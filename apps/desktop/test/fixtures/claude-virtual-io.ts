import path from "node:path";
import type { ClaudeIo, ProbeStat } from "../../../../packages/backend/src/context-claude-sources";

/**
 * An in-memory file system for the discovery calls, in POSIX or Windows spelling, that records
 * every call. It lets tests describe a workspace on a network share, or a link that leads to
 * `/net/host`, without touching the machine, and prove which paths were never looked at.
 */
export type VirtualNode = string | Buffer | { dir: true } | { link: string };
export type IoCall = {
  call: "lstat" | "readlink" | "realpath" | "readdir" | "readFile";
  path: string;
};

const absent = (file: string) =>
  Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" as const });

export function virtualIo(
  nodes: Record<string, VirtualNode>,
  platform: "posix" | "win32" = "posix",
) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const key = (value: string) => {
    const normalized = p.normalize(value);
    const root = p.parse(normalized).root;
    const trimmed =
      normalized.length > root.length && normalized.endsWith(p.sep)
        ? normalized.slice(0, -1)
        : normalized;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const tree = new Map<string, VirtualNode>();
  const add = (file: string, node: VirtualNode) => {
    tree.set(key(file), node);
    for (let parent = p.dirname(file); ; parent = p.dirname(parent)) {
      if (!tree.has(key(parent))) tree.set(key(parent), { dir: true });
      if (p.dirname(parent) === parent) break;
    }
  };
  for (const [file, node] of Object.entries(nodes)) add(file, node);
  const calls: IoCall[] = [];
  const get = (file: string) => {
    const node = tree.get(key(file));
    if (node === undefined) throw absent(file);
    return node;
  };
  const isLink = (node: VirtualNode): node is { link: string } =>
    typeof node === "object" && !Buffer.isBuffer(node) && "link" in node;
  const isDirNode = (node: VirtualNode) =>
    typeof node === "object" && !Buffer.isBuffer(node) && "dir" in node;
  const size = (node: VirtualNode) =>
    typeof node === "string" ? Buffer.byteLength(node) : Buffer.isBuffer(node) ? node.length : 0;
  /** Resolves every link, like realpath. */
  function resolve(file: string): string {
    const parts = file
      .slice(p.parse(file).root.length)
      .split(/[\\/]+/)
      .filter(Boolean);
    let current = p.parse(file).root;
    let hops = 0;
    while (parts.length) {
      const part = parts.shift()!;
      if (part === ".") continue;
      if (part === "..") {
        current = p.dirname(current);
        continue;
      }
      const next = p.join(current, part);
      const node = get(next);
      if (isLink(node)) {
        if (++hops > 40) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
        const target = node.link;
        if (p.isAbsolute(target)) {
          current = p.parse(target).root;
          parts.unshift(
            ...target
              .slice(current.length)
              .split(/[\\/]+/)
              .filter(Boolean),
          );
        } else parts.unshift(...target.split(/[\\/]+/).filter(Boolean));
      } else current = next;
    }
    return current;
  }
  const io: ClaudeIo = {
    lstat(file) {
      calls.push({ call: "lstat", path: file });
      const node = get(file);
      const stat: ProbeStat = {
        isSymbolicLink: () => isLink(node),
        isFile: () => typeof node === "string" || Buffer.isBuffer(node),
        isDirectory: () => isDirNode(node),
        size: size(node),
      };
      return stat;
    },
    readlink(file) {
      calls.push({ call: "readlink", path: file });
      const node = get(file);
      if (!isLink(node)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return node.link;
    },
    realpath(file) {
      calls.push({ call: "realpath", path: file });
      return resolve(file);
    },
    readdir(file) {
      calls.push({ call: "readdir", path: file });
      const directory = key(resolve(file));
      const names: string[] = [];
      for (const entry of tree.keys())
        if (entry !== directory && key(p.dirname(entry)) === directory)
          names.push(p.basename(entry));
      return names;
    },
    readFile(file, maxBytes) {
      calls.push({ call: "readFile", path: file });
      const node = get(file);
      if (typeof node !== "string" && !Buffer.isBuffer(node))
        throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      return Buffer.from(node).subarray(0, maxBytes);
    },
  };
  /** Calls made at or below `directory`. */
  const below = (directory: string) =>
    calls.filter(
      (entry) =>
        key(entry.path) === key(directory) ||
        key(entry.path).startsWith(key(directory) + (platform === "win32" ? "\\" : "/")),
    );
  return { io, calls, below, add: (file: string, node: VirtualNode) => add(file, node) };
}
