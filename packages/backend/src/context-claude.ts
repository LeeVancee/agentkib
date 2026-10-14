import path from "node:path";
import { isFile, within } from "./files";
import { canonicalize } from "./paths";
import {
  CLAUDE_CONFIG_DIR_VARIABLE,
  claudeConfigFiles,
  claudeManagedDir,
  resolveClaudeConfig,
  type ClaudeConfig,
} from "./claude-config";
import { MEMORY_BYTES, MEMORY_LINES, autoMemoryLocation } from "./claude-memory";
import { readClaudeSettings, type ClaudeSettings } from "./claude-settings";
import { supportsClaudeVersion } from "./claude-version";
import {
  ANCESTOR_LAYERS,
  ANCESTOR_RULES,
  USER_RULE_LIMITS,
  WORKSPACE_RULE_LIMITS,
  ancestorDirs,
  defaultIo,
  flavor,
  isInside,
  parseRule,
  pathKey,
  probe,
  walkRules,
  type ClaudeIo,
  type FileProbe,
  type OutsideMode,
  type ProbeContext,
  type ProbeResult,
  type RuleLimits,
} from "./context-claude-sources";
import {
  CONTEXT_NOTE_PREFIX,
  FILE_CHARS,
  OUTSIDE_TOTAL_CHARS,
  append,
  budgetWarning,
  decodePrefix,
  inWorkspaceScope,
  lines,
  readContext,
  type Budget,
} from "./context-files";
import { sensitive } from "./context-sources";
import type { Section } from "./context-special";
import { userHome } from "./mcp-config-read";
import { sanitizeSessionText } from "./session-handoff";

// Instructions as Claude Code loads them. The rules follow https://code.claude.com/docs/en/memory:
// - Order, from broad to narrow: managed policy CLAUDE.md, the user's CLAUDE.md and rules, then
//   every directory from the file system root down to the working directory (CLAUDE.md,
//   .claude/CLAUDE.md, the always-on rules, CLAUDE.local.md), then auto memory. Rules with a
//   `paths` field load only when a matching file is read, so they are listed, not merged.
// - AGENTS.md and .claude/AGENTS.md are read only when no CLAUDE.md, .claude/CLAUDE.md or
//   CLAUDE.local.md exists in the working directory or any parent, from Claude Code 2.1.277.
//   Neither the user-level CLAUDE.md nor managed policy or rules count. The "Project
//   instructions" choice in /config is not read; the default behavior is assumed.
// - An import is `@path` at the start of a line or after whitespace, anywhere in the line.
//   Relative paths resolve against the file that contains the import; absolute paths and `~/`
//   are allowed. Spaces are escaped with a backslash and a quoted path is not an import. Code
//   spans and fenced code blocks are skipped. Imports nest up to four hops.
// - Block-level HTML comments in CLAUDE.md files are removed before the text reaches the model.
// - Claude Code asks the user before loading imports outside the project. The preview has no such
//   step, so it filters and redacts what it reads there, and the MCP tool leaves it out.
//
// Everything outside the workspace (managed, user level, parent directories, auto memory, links
// that lead out) is read-only, bounded, filtered and redacted. What is read depends on the mode:
// `full` for the app and the CLI, `metadata` for the MCP tool (sizes and counts only, no text
// and no path), `none` for the Doctor (nothing outside the workspace is touched).
const MAX_HOPS = 4;
const MAX_IMPORTS = 256;
const MAX_TOKEN_CHARS = 4096;
const AGENTS_FROM = "2.1.277";
const note = (text: string) => `${CONTEXT_NOTE_PREFIX}${text}`;
const SETTINGS_NOT_READ = note(
  "Settings given on the command line (--settings, --setting-sources), policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings are not visible to AgentKib, and rules in parent directories are not read, so this list can differ from what Claude Code loads.",
);
const CONFIG_DIR_INVALID = note(
  "CLAUDE_CONFIG_DIR is set but is not a usable absolute path, so AgentKib reads Claude Code's default configuration folder. User-level instructions shown here may belong to a different setup than the one Claude Code uses.",
);
const AUTO_MEMORY_OFF = note(
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set in AgentKib's environment, so auto memory is not shown. Claude Code started in another environment may still load it.",
);
const LOAD_SWITCHES = note(
  "An environment variable that turns off CLAUDE.md loading (CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_SAFE_MODE or CLAUDE_CODE_SIMPLE) is set in AgentKib's environment. Claude Code started with it loads fewer instruction files than listed here; AgentKib does not model this.",
);
const HOME_FILE_NOTE = note(
  "~/.claude/CLAUDE.md is listed as a parent-directory file because CLAUDE_CONFIG_DIR points to another folder. AgentKib does not count it when deciding on the AGENTS.md fallback; whether Claude Code does is not verified.",
);
const LAYERS_NOTE = note(
  `Only the nearest ${ANCESTOR_LAYERS} parent directories were checked for instruction files.`,
);
const AGENTS_VERSION_UNKNOWN = `AGENTS.md may not be loaded: the Claude Code version could not be detected, and Claude Code reads AGENTS.md only from v${AGENTS_FROM}.`;
const agentsTooOld = (version: string) =>
  `AGENTS.md may not be loaded: Claude Code ${version} is older than v${AGENTS_FROM}, the first version that reads AGENTS.md.`;
const ASKS_FIRST =
  "Claude Code asks for approval before loading external imports, so this content may not be in effect.";
const APPROVED_EARLIER =
  "Claude Code loads external imports from AGENTS.md only if you already approved external imports for this project, and does not ask again, so this content may not be in effect.";
const OMITTED = "Its content is not included in this result.";

export interface ClaudeContextOptions {
  /** Canonical workspace root. */
  root: string;
  /** Canonical working directory, inside `root`. */
  cwd: string;
  /** Directories from `root` down to `cwd`, inclusive. */
  dirs: string[];
  environment: NodeJS.ProcessEnv;
  budget: Budget;
  warnings: string[];
  /** False for the MCP tool: contents of imports outside the project are not returned. */
  externalBodies: boolean;
  /**
   * The `claude --version` line (`X.Y.Z (Claude Code)`), or null when it cannot be determined.
   * Called only when the AGENTS.md fallback applies.
   */
  version: () => Promise<string | null>;
  /** What may be read outside the workspace. Defaults to `full`, or `metadata` without external bodies. */
  outside?: OutsideMode;
  /** The Claude configuration folder; defaults to what the environment says. */
  config?: ClaudeConfig;
  // The next four exist for tests and are never set by the application.
  /** Where organization policy files live; `null` for none. Defaults to the platform's location. */
  managedDir?: string | null;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  /** Also read `.claude/rules` of parent directories. */
  ancestorRules?: boolean;
}
type Kind = "claude" | "agents";
interface Loaded {
  content: string;
  truncated: boolean;
}
/** State shared by every source of one resolution. */
interface Shared {
  root: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  warnings: string[];
  externalBodies: boolean;
  io: ClaudeIo;
  platform: NodeJS.Platform;
  /** Warnings already emitted, so repeated imports of one file do not repeat a warning. */
  emitted: Set<string>;
  /** File reads by real path; null marks a file that could not be read. */
  reads: Map<string, Loaded | null>;
}
/** State of one top-level source and everything it imports. */
interface Source {
  shared: Shared;
  kind: Kind;
  /** Real path of the top-level file, named by the import-limit warning. */
  top: string;
  imports: number;
  limited: boolean;
  /** Characters this source may still add, and where the generic budget message goes. */
  budget: Budget;
  sink: string[];
  /** Outside the workspace: problems are notes, which the Doctor and the warning list treat as advice. */
  note: boolean;
  /** The user's own files: Claude Code does not ask before loading what they import. */
  trusted: boolean;
  /** Applied to the text of the top-level file only (comments, front matter). */
  prepare?: (text: string) => string;
}
interface Position {
  /** Real path of the file that holds the import. */
  canonical: string;
  depth: number;
  /** Files being expanded right now, for cycle detection. */
  stack: Set<string>;
  /** True once the content was reached through a file outside the project. */
  external: boolean;
}
interface Token {
  start: number;
  end: number;
  /** The path as written, with escaped spaces unescaped and `~` left alone. */
  written: string;
}

function warn(shared: Shared, text: string, asNote = false): void {
  const message = asNote && !text.startsWith(CONTEXT_NOTE_PREFIX) ? note(text) : text;
  if (shared.emitted.has(message)) return;
  shared.emitted.add(message);
  shared.warnings.push(message);
}

function read(shared: Shared, canonical: string): Loaded {
  const cached = shared.reads.get(canonical);
  if (cached) return cached;
  if (cached === null) throw new Error(`Could not read ${canonical}`);
  try {
    const loaded = readContext(canonical, (file, limit) => shared.io.readFile(file, limit));
    shared.reads.set(canonical, loaded);
    return loaded;
  } catch (error) {
    shared.reads.set(canonical, null);
    throw error;
  }
}

const SENSITIVE_NAMES = new Set([".claude.json", ".npmrc", ".netrc", ".pypirc"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure"]);
const SENSITIVE_PAIRS = [
  [".config", "gh"],
  [".config", "gcloud"],
] as const;

function looksSensitive(value: string): boolean {
  // Compare in lower case: macOS and Windows file systems ignore case by default.
  const segments = value
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment !== "");
  const name = segments.at(-1) ?? "";
  if (SENSITIVE_NAMES.has(name) || sensitive(name)) return true;
  return segments.some(
    (segment, index) =>
      SENSITIVE_DIRECTORIES.has(segment) ||
      SENSITIVE_PAIRS.some(
        ([parent, child]) => segment === parent && segments[index + 1] === child,
      ),
  );
}

/**
 * Whether an import outside the project must not be read. Checks the path as written (with `~`
 * expanded, symbolic links not followed) and the real path, so a harmless-looking link to a
 * credentials file is caught as well. Reuses the file-name rules applied to OpenCode sources.
 */
export function isSensitiveExternalPath(written: string, canonical: string): boolean {
  return looksSensitive(written) || looksSensitive(canonical);
}

interface Fence {
  char: string;
  length: number;
}
function openFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  // An info string with a backtick means this is inline code, not a fence.
  if (marker[0] === "`" && match[2]!.includes("`")) return null;
  return { char: marker[0]!, length: marker.length };
}
function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/**
 * Removes block-level HTML comments, as Claude Code does to CLAUDE.md files before the text
 * reaches the model (memory page; the same holds for CLAUDE.local.md). A block comment starts a
 * line (up to three spaces of indent) with `<!--` and ends at a `-->` that has only white space
 * after it, possibly many lines later; its lines are removed whole. Comments inside fenced code
 * blocks and inline comments stay, and so does a comment that is never closed or that has text
 * after its `-->`, because when in doubt the preview must not assume Claude Code loads less.
 * Safe to apply twice.
 */
export function stripBlockComments(text: string): string {
  if (!text.includes("<!--")) return text;
  const rows = text.split("\n");
  // closing[i]: the first row at or after i that holds a `-->`, or -1.
  const closing = new Array<number>(rows.length + 1).fill(-1);
  for (let index = rows.length - 1; index >= 0; index--)
    closing[index] = rows[index]!.includes("-->") ? index : closing[index + 1]!;
  const kept: string[] = [];
  let fence: Fence | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const bare = row.endsWith("\r") ? row.slice(0, -1) : row;
    if (fence) {
      kept.push(row);
      if (closesFence(bare, fence)) fence = null;
      continue;
    }
    const opening = openFence(bare);
    if (opening) {
      fence = opening;
      kept.push(row);
      continue;
    }
    const start = /^ {0,3}<!--/.exec(bare);
    if (start) {
      let last = index;
      let close = row.indexOf("-->", start[0].length);
      if (close < 0) {
        last = closing[index + 1]!;
        close = last < 0 ? -1 : rows[last]!.indexOf("-->");
      }
      if (close >= 0 && rows[last]!.slice(close + 3).trim() === "") {
        index = last;
        continue;
      }
    }
    kept.push(row);
  }
  return kept.join("\n");
}

/** Replace inline code spans (matching backtick runs of equal length) with spaces. */
function maskInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      output += line[index++];
      continue;
    }
    let length = 0;
    while (line[index + length] === "`") length++;
    let close = -1;
    for (let at = index + length; at < line.length;) {
      if (line[at] !== "`") {
        at++;
        continue;
      }
      let run = 0;
      while (line[at + run] === "`") run++;
      if (run === length) {
        close = at;
        break;
      }
      at += run;
    }
    if (close < 0) {
      output += line.slice(index, index + length);
      index += length;
    } else {
      output += " ".repeat(close + length - index);
      index = close + length;
    }
  }
  return output;
}

function importTokens(line: string): Token[] {
  if (!line.includes("@")) return [];
  const text = maskInlineCode(line);
  const tokens: Token[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "@" || (start > 0 && !/\s/.test(text[start - 1]!))) continue;
    let end = start + 1;
    let written = "";
    while (end < text.length) {
      const character = text[end]!;
      if (character === "\\" && text[end + 1] === " ") {
        written += " ";
        end += 2;
      } else if (/\s/.test(character)) break;
      else {
        written += character;
        end++;
      }
    }
    // A quoted path is not an import, and neither is an @ with nothing after it.
    if (written && written[0] !== '"' && written[0] !== "'") tokens.push({ start, end, written });
    start = end - 1;
  }
  return tokens;
}

/** Collects the expansion of one file; text from outside the project is redacted in runs. */
class Output {
  #text = "";
  #pending = "";
  constructor(
    readonly source: Source,
    readonly external: boolean,
  ) {}
  line(value: string): void {
    const { budget, sink } = this.source;
    if (this.external) this.#pending += `${value}\n`;
    else {
      this.#text += append(value, budget, sink);
      this.#text += append("\n", budget, sink);
    }
  }
  /** Add already-budgeted text from an import, with the line break that ended its line. */
  insert(value: string, lineBreak: boolean): void {
    this.#flush();
    this.#text += value;
    if (lineBreak) this.#text += append("\n", this.source.budget, this.source.sink);
  }
  finish(): string {
    this.#flush();
    return this.#text;
  }
  #flush(): void {
    if (!this.#pending) return;
    // Whole runs at once, so a multi-line private key is recognized and removed.
    const redacted = sanitizeSessionText(this.#pending, { value: 0 });
    this.#text += append(redacted, this.source.budget, this.source.sink);
    this.#pending = "";
  }
}

function expand(
  source: Source,
  file: string,
  canonical: string,
  depth: number,
  stack: Set<string>,
  external: boolean,
): string {
  const { shared } = source;
  const loaded = read(shared, canonical);
  if (loaded.truncated)
    warn(
      shared,
      source.note
        ? `Instruction file exceeds the preview limit and was truncated: ${file}`
        : `Instruction file exceeds ${FILE_CHARS} characters and was truncated for preview: ${file}`,
      source.note,
    );
  const output = new Output(source, external);
  const here: Position = { canonical, depth, stack, external };
  const text = depth === 0 && source.prepare ? source.prepare(loaded.content) : loaded.content;
  let fence: Fence | null = null;
  stack.add(canonical);
  try {
    for (const line of lines(text)) {
      if (!source.budget.remaining) {
        budgetWarning(source.sink);
        break;
      }
      if (fence) {
        output.line(line);
        if (closesFence(line, fence)) fence = null;
        continue;
      }
      const opening = openFence(line);
      if (opening) {
        fence = opening;
        output.line(line);
        continue;
      }
      const tokens = source.limited ? [] : importTokens(line);
      if (!tokens.length) {
        output.line(line);
        continue;
      }
      const first = line.length - line.trimStart().length;
      const last = line.trimEnd().length;
      if (tokens.length === 1 && tokens[0]!.start === first && tokens[0]!.end === last) {
        // The whole line is one import: the content replaces the line.
        const imported = resolveImport(source, here, tokens[0]!, true);
        if (imported === null) output.line(line);
        else output.insert(imported, true);
        continue;
      }
      output.line(line);
      for (const token of tokens) {
        const imported = resolveImport(source, here, token, false);
        if (imported !== null) output.insert(imported, false);
      }
    }
  } finally {
    stack.delete(canonical);
  }
  return output.finish();
}

/**
 * Where an import points. `~/` is the home directory everywhere; `~\` only on Windows, where the
 * documentation's examples use it. On Linux and macOS it is an ordinary file name character, and
 * since the documentation does not say otherwise there it is not expanded.
 */
export function importPath(
  containing: string,
  written: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  if (written.length > MAX_TOKEN_CHARS) return null;
  const home = written.startsWith("~/") || (platform === "win32" && written.startsWith("~\\"));
  const expanded = home ? path.join(userHome(environment), written.slice(2)) : written;
  return path.resolve(path.dirname(containing), expanded);
}

/**
 * The expansion of one import, or null when it is not expanded (the line stays as written).
 * Problems with an import are warnings; they never remove the file that holds the import.
 */
function resolveImport(
  source: Source,
  here: Position,
  token: Token,
  standalone: boolean,
): string | null {
  const { shared } = source;
  const holder = here.canonical;
  const tell = (text: string) => warn(shared, text, source.note);
  const resolved = importPath(holder, token.written, shared.environment, shared.platform);
  if (resolved === null || !isFile(resolved)) {
    // Only a line that is nothing but an import is reported: elsewhere an @ may well be an
    // email address or a package name, so a missing file is not worth a warning.
    if (standalone)
      tell(
        `Imported file is missing: ${resolved ?? `${token.written.slice(0, 200)}...`} (source: ${holder})`,
      );
    return null;
  }
  if (source.imports >= MAX_IMPORTS) {
    tell(
      `Instruction import limit reached (${MAX_IMPORTS}); remaining imports were not resolved (source: ${source.top})`,
    );
    source.limited = true;
    return null;
  }
  source.imports++;
  let target: string;
  try {
    target = canonicalize(resolved);
  } catch {
    tell(`Instruction import could not be read: ${resolved} (source: ${holder})`);
    return null;
  }
  if (here.stack.has(target)) {
    tell(`Instruction import skipped (circular reference): ${resolved} (source: ${holder})`);
    return null;
  }
  if (here.depth + 1 > MAX_HOPS) {
    tell(
      `Instruction import skipped (deeper than ${MAX_HOPS} hops): ${resolved} (source: ${holder})`,
    );
    return null;
  }
  // Two boundaries: outside the project decides filtering and redaction, outside the working
  // directory only decides the note, because that is what Claude Code asks about.
  const outsideProject = here.external || !within(target, shared.root);
  const external = `${CONTEXT_NOTE_PREFIX}External import (outside the working directory): ${token.written} (source: ${holder}).`;
  if (outsideProject) {
    if (isSensitiveExternalPath(resolved, target)) {
      tell(`Instruction import skipped (sensitive path): ${resolved} (source: ${holder})`);
      return null;
    }
    if (!shared.externalBodies) {
      tell(`${external} ${OMITTED}`);
      return null;
    }
  }
  // Claude Code trusts what the user's own files import and does not ask first.
  if (!source.trusted && !within(target, shared.cwd))
    tell(`${external} ${source.kind === "agents" ? APPROVED_EARLIER : ASKS_FIRST}`);
  try {
    return expand(source, resolved, target, here.depth + 1, here.stack, outsideProject);
  } catch {
    tell(`Instruction import could not be read: ${resolved} (source: ${holder})`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Discovery and assembly
// ---------------------------------------------------------------------------------------------

type Tier = "managed" | "user" | "ancestor" | "workspace";
/** What the metadata mode counts instead of showing. */
type Label = "managed" | "user" | "userRules" | "ancestor" | "memory" | "external";
const LABELS: Record<Label, { text: string; verb: string }> = {
  managed: { text: "Managed policy instructions", verb: "exist" },
  user: { text: "User instructions", verb: "exist" },
  userRules: { text: "User rules", verb: "exist" },
  ancestor: { text: "Parent-directory instruction files", verb: "exist" },
  memory: { text: "Auto memory (MEMORY.md)", verb: "exists" },
  external: { text: "External instruction sources", verb: "exist" },
};

/** One file Claude Code would load, found in load order and not read yet. */
interface Entry {
  tier: Tier;
  /** The path as written. */
  file: string;
  kind: Kind;
  /** The path after following every link. */
  real: string;
  size: number;
  /** The first link on the way to the file, as written. */
  link?: string;
  label: Label;
  rule: boolean;
  /** CLAUDE.md-family files lose their block-level HTML comments. */
  strip: boolean;
}
interface Hit {
  name: string;
  file: string;
  result: ProbeResult;
  /** This file is the user's own CLAUDE.md, reached through a directory of the chain. */
  isUser: boolean;
  /** This file is the literal ~/.claude/CLAUDE.md. */
  isHome: boolean;
}
interface Link {
  dir: string;
  tier: "ancestor" | "workspace";
  hits: Hit[];
}
interface Tally {
  files: number;
  bytes: number;
  shortened: boolean;
  skipped: number;
}

const CLAUDE_NAMES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const AGENTS_NAMES = ["AGENTS.md", ".claude/AGENTS.md"];
const PATH_LIST_ROWS = 8;
/** Variables that change what is loaded; a settings `env` block can set them, which AgentKib only notes. */
const ENV_BLOCK_NAMES = [
  CLAUDE_CONFIG_DIR_VARIABLE,
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
];
const LOAD_SWITCH_NAMES = [
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
];

const isFound = (result: ProbeResult): result is FileProbe => result.kind === "file";

/** What a rule with a `paths` field shows: the patterns, not the text. */
function patternList(paths: string[]): string {
  const shown = paths.slice(0, PATH_LIST_ROWS).map((pattern) => `- ${pattern}`);
  if (paths.length > PATH_LIST_ROWS) shown.push(`… (+${paths.length - PATH_LIST_ROWS} more)`);
  return `paths:\n${shown.join("\n")}\n`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

class Assembly {
  readonly mode: OutsideMode;
  readonly platform: NodeJS.Platform;
  readonly context: ProbeContext;
  readonly p: typeof path.posix;
  readonly config: ClaudeConfig;
  readonly home: string;
  readonly shared: Shared;
  /** Entries in load order, and the sections made from them. */
  readonly entries: Entry[] = [];
  readonly sections: Section[] = [];
  readonly conditional: Section[] = [];
  readonly outsideBudget: Budget = { remaining: OUTSIDE_TOTAL_CHARS };
  readonly outsideSink: string[] = [];
  readonly tallies = new Map<Label, Tally>();
  /** Real paths of outside files already listed, so one file is not shown twice. */
  readonly seenOutside = new Set<string>();
  readonly seenAgents = new Set<string>();
  /** Sections about settings and assets, listed after the instructions. */
  readonly extras: Section[] = [];
  readonly settings: ClaudeSettings;
  /** Something outside the workspace (shown, counted or skipped) was met. */
  outsideSeen = false;
  conditionalSeen = false;
  agentsSeen = false;
  #userDir: string | null = null;
  #homeDir: string | null = null;
  #userRulesDir: string | null = null;

  constructor(readonly options: ClaudeContextOptions) {
    this.platform = options.platform ?? process.platform;
    this.context = { io: options.io ?? defaultIo, platform: this.platform };
    this.p = flavor(this.platform);
    this.mode = options.outside ?? (options.externalBodies ? "full" : "metadata");
    this.home = userHome(options.environment);
    this.config =
      options.config ?? resolveClaudeConfig(options.environment, this.home, this.platform);
    this.settings = readClaudeSettings({
      root: options.root,
      cwd: options.cwd,
      environment: options.environment,
      mode: this.mode,
      config: this.config,
      managedDir: options.managedDir,
      platform: this.platform,
      io: this.context.io,
      sensitive: isSensitiveExternalPath,
    });
    this.shared = {
      root: options.root,
      cwd: options.cwd,
      environment: options.environment,
      warnings: options.warnings,
      externalBodies: options.externalBodies,
      io: this.context.io,
      platform: this.platform,
      emitted: new Set(options.warnings),
      reads: new Map(),
    };
  }

  key = (value: string) => pathKey(value, this.platform);
  warn = (text: string, asNote = false) => warn(this.shared, text, asNote);
  probeIn = (directory: string, name: string) =>
    probe(this.p.join(directory, name), directory, this.context);

  tally(label: Label, size: number | null, shortened?: boolean): void {
    const entry = this.tallies.get(label) ?? { files: 0, bytes: 0, shortened: false, skipped: 0 };
    if (size === null) entry.skipped++;
    else {
      entry.files++;
      entry.bytes += size;
      entry.shortened ||= shortened ?? size >= FILE_CHARS;
    }
    this.tallies.set(label, entry);
  }
  skipNetwork(file: string, label: Label): void {
    this.outsideSeen = true;
    if (this.mode === "full") this.warn(`Instruction source skipped (network path): ${file}`, true);
    else if (this.mode === "metadata") this.tally(label, null);
  }
  skipUnreadable(file: string, label: Label): void {
    this.outsideSeen = true;
    if (this.mode === "full") this.warn(`Instruction source could not be read: ${file}`, true);
    else if (this.mode === "metadata") this.tally(label, null);
  }

  // ---- discovery -------------------------------------------------------------------------

  /** The folder that holds `name` for a hit, when that is where the user's own files live. */
  #holder(directory: string, name: string): string | null {
    if (name === "CLAUDE.md") return directory;
    if (name !== ".claude/CLAUDE.md") return null;
    const dot = this.probeIn(directory, ".claude");
    return dot.kind === "dir" ? dot.real : null;
  }
  #hit(directory: string, name: string): Hit {
    const file = this.p.join(directory, name);
    const result = probe(file, directory, this.context);
    let isUser = false;
    let isHome = false;
    if (isFound(result) && this.mode !== "none") {
      const inside = this.#holder(directory, name);
      if (inside !== null) {
        isUser = this.#userDir !== null && this.key(inside) === this.key(this.#userDir);
        isHome = this.#homeDir !== null && this.key(inside) === this.key(this.#homeDir);
      }
    }
    return { name, file, result, isUser, isHome };
  }

  /** Adds one file; links to network paths and unreadable paths are reported, not followed. */
  #add(
    tier: Tier,
    file: string,
    result: ProbeResult,
    label: Label,
    kind: Kind,
    strip: boolean,
  ): void {
    if (result.kind === "network") return this.skipNetwork(file, label);
    if (!isFound(result)) {
      // Outside the workspace an unreadable path is worth a note; inside it, as before, it is
      // simply not a file.
      if (tier !== "workspace" && result.kind === "unreadable") this.skipUnreadable(file, label);
      return;
    }
    const id = this.key(result.real);
    if (tier !== "workspace") {
      if (this.seenOutside.has(id)) return;
      this.seenOutside.add(id);
    }
    if (kind === "agents") {
      if (this.seenAgents.has(id)) return;
      this.seenAgents.add(id);
      this.agentsSeen = true;
    }
    this.entries.push({
      tier,
      file,
      kind,
      real: result.real,
      size: result.size,
      ...(result.link ? { link: result.link } : {}),
      label,
      rule: false,
      strip,
    });
  }

  /** Adds the `.md` files below a rules folder; `top` is the probe of the folder itself. */
  #addRules(
    tier: Exclude<Tier, "managed">,
    directory: string,
    top: ProbeResult,
    label: Label,
    limits: RuleLimits,
  ): void {
    const owner: Label = tier === "workspace" ? "external" : label;
    if (top.kind === "network") return this.skipNetwork(directory, owner);
    if (top.kind !== "dir") return;
    if (
      tier === "workspace" &&
      this.mode === "none" &&
      !isInside(top.real, this.options.root, this.platform)
    ) {
      // The Doctor looks at nothing outside the project, so a rules folder that leads out of it
      // is refused as a whole instead of being listed.
      this.warn(`Instruction source skipped (outside the project): ${directory}`);
      return;
    }
    // The Doctor lists nothing outside the project: a folder inside the rules folder that links
    // out of it is passed over (as it always was), not entered.
    const stayInside =
      tier === "workspace" && this.mode === "none"
        ? (real: string) => isInside(real, this.options.root, this.platform)
        : undefined;
    const walk = walkRules(top, directory, limits, this.context, stayInside);
    if (walk.network) this.skipNetwork(directory, owner);
    if (walk.limited)
      this.warn(
        `Rule files in ${tier === "workspace" ? directory : LABELS[label].text} exceed the preview limits (${limits.files} files, ${limits.depth} folder levels); the rest were not read.`,
        true,
      );
    for (const rule of walk.files) {
      const link = rule.link ?? top.link;
      this.entries.push({
        tier,
        file: rule.written,
        kind: "claude",
        real: rule.real,
        size: rule.size,
        ...(link ? { link } : {}),
        label: owner,
        rule: true,
        strip: false,
      });
    }
  }

  /** Finds every source in load order. Returns whether the AGENTS.md fallback applies. */
  discover(): boolean {
    const { mode, platform, p, context, options, config } = this;
    const files = claudeConfigFiles(config, platform);
    if (mode !== "none") {
      const user = probe(config.dir, null, context);
      if (user.kind === "dir") this.#userDir = user.real;
      const standard = probe(p.join(this.home, ".claude"), null, context);
      if (standard.kind === "dir") this.#homeDir = standard.real;
      const rules = probe(files.userRules, null, context);
      if (rules.kind === "dir") this.#userRulesDir = rules.real;
    }
    const above =
      mode === "none"
        ? { dirs: [] as string[], limited: false }
        : ancestorDirs(options.root, platform);
    if (above.limited) this.warn(LAYERS_NOTE);
    const links: Link[] = [
      ...above.dirs.map((dir) => ({ dir, tier: "ancestor" as const })),
      ...options.dirs.map((dir) => ({ dir, tier: "workspace" as const })),
    ].map((link) => ({ ...link, hits: CLAUDE_NAMES.map((name) => this.#hit(link.dir, name)) }));
    // Only an existing CLAUDE.md-style file stops the fallback. The user's CLAUDE.md and
    // ~/.claude/CLAUDE.md, managed policy files and rules do not count, and neither does a file
    // that is later refused.
    const fallback = !links.some((link) =>
      link.hits.some((hit) => isFound(hit.result) && !hit.isUser && !hit.isHome),
    );

    if (mode !== "none") {
      const managed =
        options.managedDir === undefined ? claudeManagedDir(platform) : options.managedDir;
      if (managed) {
        const file = p.join(managed, "CLAUDE.md");
        this.#add("managed", file, probe(file, null, context), "managed", "claude", true);
      }
      const user = files.userInstructions;
      this.#add("user", user, probe(user, null, context), "user", "claude", true);
      this.#addRules(
        "user",
        files.userRules,
        probe(files.userRules, null, context),
        "userRules",
        USER_RULE_LIMITS,
      );
    }
    const ancestorRules = options.ancestorRules ?? ANCESTOR_RULES;
    for (const link of links) {
      const workspace = link.tier === "workspace";
      const label: Label = workspace ? "external" : "ancestor";
      // Within one directory: CLAUDE.md, .claude/CLAUDE.md, (AGENTS.md), rules, CLAUDE.local.md.
      for (const hit of link.hits.slice(0, 2)) {
        if (hit.isUser) continue; // read once, as the user's own file
        if (hit.isHome && isFound(hit.result)) this.warn(HOME_FILE_NOTE);
        this.#add(link.tier, hit.file, hit.result, label, "claude", true);
      }
      if (fallback)
        for (const name of AGENTS_NAMES) {
          const file = p.join(link.dir, name);
          this.#add(link.tier, file, probe(file, link.dir, context), label, "agents", false);
        }
      if (workspace || ancestorRules) {
        const directory = p.join(link.dir, ".claude", "rules");
        const top = probe(directory, link.dir, context);
        const user =
          top.kind === "dir" &&
          this.#userRulesDir !== null &&
          this.key(top.real) === this.key(this.#userRulesDir);
        if (!user)
          this.#addRules(
            link.tier,
            directory,
            top,
            label,
            workspace ? WORKSPACE_RULE_LIMITS : USER_RULE_LIMITS,
          );
      }
      const local = link.hits[2]!;
      this.#add(link.tier, local.file, local.result, label, "claude", true);
    }
    return fallback;
  }

  // ---- loading ---------------------------------------------------------------------------

  #scope(entry: Entry): string {
    return entry.tier === "workspace"
      ? inWorkspaceScope(this.p.relative(this.options.root, this.p.dirname(entry.file)))
      : entry.tier;
  }
  #source(entry: Entry, budget: Budget, sink: string[], outside: boolean): Source {
    return {
      shared: this.shared,
      kind: entry.kind,
      top: entry.real,
      imports: 0,
      limited: false,
      budget,
      sink,
      note: outside,
      trusted: entry.tier === "user",
    };
  }
  /**
   * Chooses how the text of a top-level file is prepared. A rule with a `paths` field is only
   * listed (`show` decides whether it is) and is not loaded; returns false then.
   */
  #prepare(entry: Entry, source: Source, show: boolean): boolean {
    if (entry.rule) {
      const rule = parseRule(read(this.shared, entry.real).content);
      if (rule.paths) {
        this.conditionalSeen = true;
        if (show)
          this.conditional.push({
            source: entry.file,
            scope: "conditional",
            content: patternList(rule.paths),
            precedence: 0,
          });
        return false;
      }
      source.prepare = (text) => parseRule(text).body;
    } else if (entry.strip) source.prepare = stripBlockComments;
    return true;
  }

  load(entry: Entry): void {
    if (entry.tier === "workspace" && isInside(entry.real, this.options.root, this.platform))
      this.#loadInside(entry);
    else this.#loadOutside(entry);
  }
  #loadInside(entry: Entry): void {
    const { budget, warnings } = this.options;
    if (!budget.remaining) return budgetWarning(warnings);
    const source = this.#source(entry, budget, warnings, false);
    try {
      if (!this.#prepare(entry, source, true)) return;
      this.sections.push({
        source: entry.file,
        scope: this.#scope(entry),
        content: expand(source, entry.file, entry.real, 0, new Set(), false),
        precedence: 0,
      });
    } catch {
      this.warn(`Could not read ${entry.file}`);
    }
  }
  #loadOutside(entry: Entry): void {
    const { mode } = this;
    this.outsideSeen = true;
    // The Doctor reads nothing outside the workspace; a link that leads out is refused, as it
    // always was.
    if (mode === "none")
      return this.warn(`Instruction source skipped (outside the project): ${entry.file}`);
    if (isSensitiveExternalPath(entry.file, entry.real)) {
      if (mode === "metadata") return this.tally(entry.label, null);
      return this.warn(`Instruction source skipped (sensitive path): ${entry.file}`, true);
    }

    if (mode === "metadata") return this.tally(entry.label, entry.size);
    if (!this.outsideBudget.remaining) return budgetWarning(this.outsideSink);
    const source = this.#source(entry, this.outsideBudget, this.outsideSink, true);
    const link = entry.link ?? entry.file;
    try {
      // A rule that leads out of the workspace and has a `paths` field never loads (Claude Code
      // loads such links only without `paths`), so it is not listed.
      if (!this.#prepare(entry, source, entry.tier !== "workspace")) return;
      if (entry.tier === "workspace")
        this.warn(
          entry.rule
            ? `External rule file (outside the working directory): ${entry.file} (link: ${link}). Claude Code asks for approval before loading it and then loads it only when it has no paths field, so this content may not be in effect.`
            : `External instruction source (outside the working directory): ${entry.file} (link: ${link}). Claude Code may ask for approval before loading it, so this content may not be in effect.`,
          true,
        );
      this.sections.push({
        source: entry.file,
        scope: this.#scope(entry),
        content: expand(source, entry.file, entry.real, 0, new Set(), true),
        precedence: 0,
      });
    } catch {
      this.warn(`Instruction source could not be read: ${entry.file}`, true);
    }
  }

  /** Auto memory: the first 200 lines or 25,000 bytes of MEMORY.md, after comments are removed. */
  memory(): void {
    if (this.mode === "none") return;
    const { options } = this;
    const location = autoMemoryLocation(
      options.cwd,
      this.config,
      options.environment,
      this.context,
    );
    if (!location.ok) {
      if (location.reason === "disabled") this.warn(AUTO_MEMORY_OFF);
      else if (location.reason !== "empty-path")
        this.warn(
          note(
            `Auto memory was not located (${location.reason === "path-too-long" ? "path too long" : "project directory name overridden"}).`,
          ),
        );
      return;
    }
    const file = location.file;
    const found = probe(file, null, this.context);
    if (found.kind === "network") return this.skipNetwork(file, "memory");
    if (found.kind === "unreadable") return this.skipUnreadable(file, "memory");
    if (!isFound(found)) return;
    this.outsideSeen = true;
    if (isSensitiveExternalPath(file, found.real)) {
      if (this.mode === "metadata") return this.tally("memory", null);
      return this.warn(`Instruction source skipped (sensitive path): ${file}`, true);
    }
    if (this.mode === "metadata")
      return this.tally("memory", found.size, found.size > MEMORY_BYTES);
    if (!this.outsideBudget.remaining) return budgetWarning(this.outsideSink);
    try {
      const loaded = read(this.shared, found.real);
      let text = stripBlockComments(parseRule(loaded.content).body);
      let shortened = loaded.truncated;
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > MEMORY_BYTES) {
        text = decodePrefix(bytes.subarray(0, MEMORY_BYTES), true);
        shortened = true;
      }
      const rows = lines(text);
      if (rows.length > MEMORY_LINES) {
        text = `${rows.slice(0, MEMORY_LINES).join("\n")}\n`;
        shortened = true;
      }
      this.sections.push({
        source: file,
        scope: "auto-memory",
        content: append(
          sanitizeSessionText(text, { value: 0 }),
          this.outsideBudget,
          this.outsideSink,
        ),
        precedence: 0,
      });
      if (shortened)
        this.warn(
          "MEMORY.md is longer than Claude Code reads at startup (200 lines or 25,000 bytes); only the first part is shown.",
          true,
        );
    } catch {
      this.warn(`Instruction source could not be read: ${file}`, true);
    }
  }

  // ---- result ----------------------------------------------------------------------------

  /**
   * What the settings say, as a section in the app and as metadata over MCP. Nothing is read for
   * the Doctor.
   */
  #settingsOutput(): void {
    const { mode, settings } = this;
    if (mode === "none") return;
    if (settings.anyFile) {
      if (mode === "full") {
        for (const file of settings.files)
          if (file.status === "network" || file.status === "unreadable")
            this.warn(
              `Settings file skipped (${file.status === "network" ? "network path" : "could not be read"}): ${file.file}`,
              true,
            );
        this.extras.push({
          source: "Claude Code settings",
          scope: "settings",
          content: settings.describe("full"),
          precedence: 0,
        });
        for (const file of settings.files)
          if (file.status === "unparseable" || file.status === "not-object") {
            const at = file.position
              ? ` (line ${file.position.line}, column ${file.position.column})`
              : "";
            this.warn(
              `Settings file cannot be used${at}: ${file.file}. Claude Code reports a Settings Error for a user, project or local file and skips it.`,
              true,
            );
          }
      } else {
        const project = settings.files.find((file) => file.layer === "project");
        const showProject = project?.status === "ok" && !project.outside;
        if (showProject)
          this.extras.push({
            source: "Claude Code settings (project)",
            scope: "settings",
            content: settings.describe("project-metadata"),
            precedence: 0,
          });
        for (const line of settings.metadataLines(showProject ? ["project"] : []))
          this.warn(line, true);
      }
    }
    const names = ENV_BLOCK_NAMES.filter((name) => settings.envSets(name));
    if (names.length)
      this.warn(
        `The env block of a settings file sets ${names.join(", ")}. AgentKib reads these variables from its own environment only, so this list can differ from what Claude Code loads.`,
        true,
      );
  }

  async finish(fallback: boolean): Promise<Section[]> {
    const { mode, options } = this;
    for (const [label, entry] of [...this.tallies].sort(
      ([left], [right]) => Object.keys(LABELS).indexOf(left) - Object.keys(LABELS).indexOf(right),
    )) {
      const { text, verb } = LABELS[label];
      const details = [
        plural(entry.files, "file"),
        plural(entry.bytes, "byte"),
        ...(entry.shortened ? ["may be shortened"] : []),
        ...(entry.skipped ? [`${entry.skipped} skipped`] : []),
      ];
      this.warn(
        `${text} ${verb} (${details.join(", ")}); its content is not included in this result.`,
        true,
      );
    }
    if (this.outsideSink.length)
      this.warn(
        `The budget for instruction sources outside the workspace (${OUTSIDE_TOTAL_CHARS / 1024} Ki characters) was used up; later sources were not read.`,
        true,
      );
    this.#settingsOutput();
    if (fallback && this.agentsSeen) {
      let version: string | null = null;
      try {
        version = await options.version();
      } catch {
        // A version that cannot be read is an unknown version, never a failed preview.
      }
      if (version === null) this.warn(AGENTS_VERSION_UNKNOWN);
      else if (!supportsClaudeVersion(version, AGENTS_FROM))
        this.warn(agentsTooOld(version.split(" ")[0]!));
    }
    if (LOAD_SWITCH_NAMES.some((name) => options.environment[name] === "1"))
      this.warn(LOAD_SWITCHES);
    if (mode !== "none" && this.config.invalid) this.warn(CONFIG_DIR_INVALID);
    if (this.outsideSeen || this.conditionalSeen || this.agentsSeen || this.settings.anyFile)
      this.warn(SETTINGS_NOT_READ);
    return [...this.sections, ...this.conditional, ...this.extras].map((section, precedence) => ({
      ...section,
      precedence,
    }));
  }
}

/** The instruction sections Claude Code would load for this working directory. */
export async function claudeSections(options: ClaudeContextOptions): Promise<Section[]> {
  const assembly = new Assembly(options);
  const fallback = assembly.discover();
  for (const entry of assembly.entries) assembly.load(entry);
  assembly.memory();
  return assembly.finish(fallback);
}
