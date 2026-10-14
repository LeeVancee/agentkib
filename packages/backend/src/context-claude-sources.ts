import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { prefix } from "./context-files";
import { canonicalize } from "./paths";
import { compareUtf8 } from "./workspaces";

// Discovery of the files Claude Code loads, as far as the file system is concerned: whether a
// path is a file, what it really is after following links, and which rule files a directory
// holds. Nothing here reads a file's contents except the small front matter helper below.
//
// Basis, https://code.claude.com/docs/en/memory ("Share rules across projects with symlinks"):
// a symlink to a network path (a UNC share, or a path under /net or /Network) is not followed,
// because looking it up could contact the host it points to; \\wsl$ is not a network path.

/** What may be read outside the workspace: everything, only sizes and counts, or nothing. */
export type OutsideMode = "full" | "metadata" | "none";

export interface ProbeStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}
/** The file system calls discovery makes. Tests replace it to prove which paths were touched. */
export interface ClaudeIo {
  lstat(file: string): ProbeStat;
  readlink(file: string): string;
  realpath(file: string): string;
  readdir(directory: string): string[];
  readFile(file: string, maxBytes: number): Buffer;
}
export const defaultIo: ClaudeIo = {
  lstat: (file) => lstatSync(file),
  readlink: (file) => readlinkSync(file),
  realpath: (file) => canonicalize(file),
  readdir: (directory) => readdirSync(directory),
  readFile: (file, maxBytes) => prefix(file, maxBytes),
};
export interface ProbeContext {
  io: ClaudeIo;
  platform: NodeJS.Platform;
}

/**
 * The rules for parent directories and rule folders. Claude Code loads the `.claude/rules` of
 * parent directories at startup too (checked with Claude Code 2.1.299), so they are read like the
 * fixed file names of those directories.
 */
export const ANCESTOR_LAYERS = 32;
export const ANCESTOR_RULES = true;
export interface RuleLimits {
  files: number;
  depth: number;
  entries: number;
}
export const USER_RULE_LIMITS: RuleLimits = { files: 64, depth: 8, entries: 512 };
export const WORKSPACE_RULE_LIMITS: RuleLimits = { files: 256, depth: 16, entries: 512 };

const MAX_HOPS = 8;
const MAX_RULE_FOLDERS = 512;
const FRONT_MATTER_WINDOW = 64 * 1024;
const MAX_PATH_PATTERNS = 64;
const MAX_PATTERN_CHARS = 256;

export const flavor = (platform: NodeJS.Platform) =>
  platform === "win32" ? path.win32 : path.posix;

/** Equality key for paths: Windows ignores case. */
export const pathKey = (value: string, platform: NodeJS.Platform) =>
  platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;

/** Whether `child` is `parent` or below it, comparing the way the platform does. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const p = flavor(platform);
  const relative = p.relative(pathKey(parent, platform), pathKey(child, platform));
  return (
    relative === "" ||
    (!p.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${p.sep}`))
  );
}

/**
 * Whether following a link to `value` would leave the machine: a UNC share on Windows, or a path
 * under /net or /Network elsewhere. It judges the path text only and is applied to what a symbolic
 * link leads to, never to where the workspace itself lives.
 */
export function isNetworkPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const text = value.replaceAll("/", "\\");
    if (!text.startsWith("\\\\")) return false;
    // \\wsl$ is the local Linux file system. \\wsl.localhost is not mentioned by the
    // documentation, so it counts as a network path, the cautious direction.
    if (/^\\\\wsl\$(\\|$)/i.test(text)) return false;
    // \\?\ and \\.\ name devices; only \\?\UNC\ is a share (devices are refused separately).
    if (/^\\\\[?.](\\|$)/.test(text)) return /^\\\\[?.]\\UNC(\\|$)/i.test(text);
    return true;
  }
  return /^\/(net|network)(\/|$)/.test(path.posix.normalize(value).toLowerCase());
}
/** Like `isNetworkPath`, plus Windows device namespaces. For paths taken from untrusted text. */
export function isNetworkOrDevicePath(value: string, platform: NodeJS.Platform): boolean {
  return (
    isNetworkPath(value, platform) || (platform === "win32" && /^[\\/]{2}[?.][\\/]/.test(value))
  );
}

interface Located {
  /** The path after following every link; the written path itself when there is no link. */
  real: string;
  size: number;
  /** True when a link was followed on the way. */
  linked: boolean;
  /** The first link met, as written. */
  link?: string;
}
export type FileProbe = Located & { kind: "file" };
export type DirProbe = Located & { kind: "dir" };
export type ProbeResult = { kind: "missing" | "unreadable" | "network" } | FileProbe | DirProbe;

const absent = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * Classifies `target` without trusting any link on the way to it.
 *
 * Every component below `base` is looked at with `lstat` before it is used. `base` must be a
 * canonical directory that contains `target`; `null` starts at the file system root, for paths
 * that have no canonical starting point (the user's configuration folder is often a link).
 * A link is resolved by hand: its text replaces the component, and once any link has been
 * followed, each further path is checked with `isNetworkPath` before it is touched. A path that
 * was reached without following a link is never judged, so a workspace that lives on a network
 * share keeps working.
 */
export function probe(target: string, base: string | null, context: ProbeContext): ProbeResult {
  const { io, platform } = context;
  const p = flavor(platform);
  const split = (value: string) =>
    value.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part !== "");
  let resolved: string;
  let queue: string[];
  if (base === null) {
    resolved = p.parse(target).root;
    queue = split(target.slice(resolved.length));
  } else {
    resolved = base;
    queue = split(p.relative(base, target));
  }
  let followed = false;
  let link: string | undefined;
  let hops = 0;
  let stat: ProbeStat | null = null;
  while (queue.length) {
    const part = queue.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = p.dirname(resolved);
      stat = null;
      continue;
    }
    const next = p.join(resolved, part);
    if (followed && isNetworkPath(next, platform)) return { kind: "network" };
    let entry: ProbeStat;
    try {
      entry = io.lstat(next);
    } catch (error) {
      return { kind: absent(error) ? "missing" : "unreadable" };
    }
    if (!entry.isSymbolicLink()) {
      resolved = next;
      stat = entry;
      continue;
    }
    if (++hops > MAX_HOPS) return { kind: "unreadable" };
    let text: string;
    try {
      text = io.readlink(next);
    } catch {
      return { kind: "unreadable" };
    }
    followed = true;
    link ??= next;
    if (p.isAbsolute(text)) {
      resolved = p.parse(text).root;
      if (isNetworkPath(resolved, platform)) return { kind: "network" };
      queue = [...split(text.slice(resolved.length)), ...queue];
      stat = null;
    } else queue = [...split(text), ...queue];
  }
  if (followed && isNetworkPath(resolved, platform)) return { kind: "network" };
  let real = resolved;
  try {
    if (followed) {
      real = io.realpath(resolved);
      if (isNetworkPath(real, platform)) return { kind: "network" };
    }
    stat ??= io.lstat(real);
  } catch (error) {
    return { kind: absent(error) ? "missing" : "unreadable" };
  }
  const found = { real, size: stat.size, linked: followed, ...(link ? { link } : {}) };
  if (stat.isFile()) return { kind: "file", ...found };
  if (stat.isDirectory()) return { kind: "dir", ...found };
  return { kind: "unreadable" };
}

/**
 * `/net` and `/Network` themselves, the folders under which automounters list remote hosts. Looking
 * for a file inside them (`/net/CLAUDE.md`, `/net/.git`) can make the automounter try to resolve
 * the file's name as a host name, so a search that climbs out of a workspace on a network share
 * steps over them. The hosts below are not skipped: they are where the workspace lives.
 */
export function isAutomountRoot(value: string, platform: NodeJS.Platform): boolean {
  return platform !== "win32" && /^\/(net|network)$/.test(value.replace(/\/+$/, "").toLowerCase());
}

/** The directories above the workspace root, farthest first. The file system root is not one of them. */
export function ancestorDirs(
  root: string,
  platform: NodeJS.Platform,
): { dirs: string[]; limited: boolean } {
  const p = flavor(platform);
  const nearestFirst: string[] = [];
  for (let current = p.dirname(root); p.dirname(current) !== current; current = p.dirname(current))
    if (!isAutomountRoot(current, platform)) nearestFirst.push(current);
  return {
    dirs: nearestFirst.slice(0, ANCESTOR_LAYERS).reverse(),
    limited: nearestFirst.length > ANCESTOR_LAYERS,
  };
}

export interface RuleEntry {
  /** Path below the rules directory, with `/` separators. */
  relative: string;
  written: string;
  real: string;
  size: number;
  linked: boolean;
  link?: string;
}
export interface RuleWalk {
  files: RuleEntry[];
  /** Entries skipped because a link on the way to them leads to a network path. */
  network: number;
  /** `.md` entries that could not be examined. */
  unreadable: number;
  /** A limit was reached: more files, deeper folders or more entries than the limits allow. */
  limited: boolean;
}

/**
 * The `.md` files below a rules directory, found recursively. `top` is the probe of the directory
 * itself (a directory, whose `real` path is listed); links to files and folders are followed one
 * path at a time through `probe`, and a folder that was already visited is not entered again.
 */
export function walkRules(
  top: DirProbe,
  written: string,
  limits: RuleLimits,
  context: ProbeContext,
  /** Whether a folder reached through a link may be entered, judged by its real path. */
  mayEnter: (real: string) => boolean = () => true,
): RuleWalk {
  const p = flavor(context.platform);
  const result: RuleWalk = { files: [], network: 0, unreadable: 0, limited: false };
  const visited = new Set<string>([pathKey(top.real, context.platform)]);
  let full = false;
  const visit = (directory: string, real: string, relative: string, depth: number) => {
    // Entries per folder and depth are bounded, but a wide tree of folders is not, so the number
    // of folders listed is bounded as well.
    if (visited.size > MAX_RULE_FOLDERS) {
      result.limited = full = true;
      return;
    }
    let names: string[];
    try {
      names = context.io.readdir(real);
    } catch {
      result.unreadable++;
      return;
    }
    names.sort(compareUtf8);
    if (names.length > limits.entries) {
      names = names.slice(0, limits.entries);
      result.limited = true;
    }
    for (const name of names) {
      if (full) return;
      const below = relative ? `${relative}/${name}` : name;
      const found = probe(p.join(real, name), real, context);
      if (found.kind === "network") result.network++;
      else if (found.kind === "dir") {
        const key = pathKey(found.real, context.platform);
        if (visited.has(key) || !mayEnter(found.real)) continue;
        if (depth >= limits.depth) {
          result.limited = true;
          continue;
        }
        visited.add(key);
        visit(p.join(directory, name), found.real, below, depth + 1);
      } else if (name.endsWith(".md")) {
        if (found.kind !== "file") {
          result.unreadable++;
          continue;
        }
        if (result.files.length >= limits.files) {
          result.limited = full = true;
          return;
        }
        result.files.push({
          relative: below,
          written: p.join(directory, name),
          real: found.real,
          size: found.size,
          linked: found.linked,
          ...(found.link ? { link: found.link } : {}),
        });
      }
    }
  };
  visit(written, top.real, "", 0);
  result.files.sort((left, right) => compareUtf8(left.relative, right.relative));
  return result;
}

export interface RuleText {
  /** The text without its front matter. The original text when there is none or it cannot be parsed. */
  body: string;
  /** The `paths` patterns, or null when the rule applies at startup. */
  paths: string[] | null;
}

/** Splits at commas that are not inside braces, so `*.{ts,tsx}` stays one pattern. */
function splitPatterns(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "{") depth++;
    else if (character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * Reads the front matter of a rule file. `paths` is the only field Claude Code looks at; it is a
 * YAML list or a comma-separated string. Front matter that cannot be parsed counts as absent and
 * the text is kept as it is, because it is not documented whether Claude Code removes it then.
 */
export function parseRule(text: string): RuleText {
  const plain: RuleText = { body: text, paths: null };
  const content = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return plain;
  const rest = content.slice(opening[0].length);
  let closeAt = -1;
  let closeLength = 0;
  for (let offset = 0; offset <= Math.min(rest.length, FRONT_MATTER_WINDOW);) {
    const newline = rest.indexOf("\n", offset);
    const end = newline < 0 ? rest.length : newline;
    if (/^(---|\.\.\.)[ \t]*$/.test(rest.slice(offset, end).replace(/\r$/, ""))) {
      closeAt = offset;
      closeLength = (newline < 0 ? end : end + 1) - offset;
      break;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (closeAt < 0) return plain;
  let data: unknown;
  try {
    // "error", not "silent": an unparseable document must throw, and warnings must not be printed.
    data = parseYaml(rest.slice(0, closeAt), { maxAliasCount: 10, logLevel: "error" });
  } catch {
    return plain;
  }
  const body = rest.slice(closeAt + closeLength);
  const raw =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).paths
      : undefined;
  const listed =
    typeof raw === "string"
      ? splitPatterns(raw)
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string")
        : [];
  const paths = listed
    .map((item) => item.trim())
    .filter((item) => item !== "" && item.length <= MAX_PATTERN_CHARS)
    .slice(0, MAX_PATH_PATTERNS);
  return { body, paths: paths.length ? paths : null };
}
