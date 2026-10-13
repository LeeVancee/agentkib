import path from "node:path";
import { isFile, within } from "./files";
import { canonicalize, pathIdentity } from "./paths";
import { supportsClaudeVersion } from "./claude-version";
import {
  CONTEXT_NOTE_PREFIX,
  FILE_CHARS,
  append,
  budgetWarning,
  lines,
  readContext,
  sortedFiles,
  type Budget,
} from "./context-files";
import { sensitive } from "./context-sources";
import type { Section } from "./context-special";
import { userHome } from "./mcp-config-read";
import { sanitizeSessionText } from "./session-handoff";

// Project instructions as Claude Code loads them, from the workspace root down to the working
// directory: CLAUDE.md files, the AGENTS.md fallback, and `.claude/rules`, with `@path` imports.
// The rules follow https://code.claude.com/docs/en/memory:
// - AGENTS.md and .claude/AGENTS.md are read only when no CLAUDE.md, .claude/CLAUDE.md or
//   CLAUDE.local.md exists in the working directory or any parent, from Claude Code 2.1.277.
//   The "Project instructions" choice in /config is not read; the default behavior is assumed.
// - An import is `@path` at the start of a line or after whitespace, anywhere in the line.
//   Relative paths resolve against the file that contains the import; absolute paths and `~/`
//   are allowed. Spaces are escaped with a backslash and a quoted path is not an import. Code
//   spans and fenced code blocks are skipped. Imports nest up to four hops.
// - Claude Code asks the user before loading imports outside the project. The preview has no such
//   step, so it filters and redacts what it reads there, and the MCP tool leaves it out.
const MAX_HOPS = 4;
const MAX_IMPORTS = 256;
const MAX_TOKEN_CHARS = 4096;
const AGENTS_FROM = "2.1.277";
const ABOVE_ROOT_NOTE = `${CONTEXT_NOTE_PREFIX}Directories above the workspace root were not checked for CLAUDE.md. If one exists there, Claude Code reads CLAUDE.md files only and ignores AGENTS.md.`;
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
  budget: Budget;
  warnings: string[];
  externalBodies: boolean;
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

function warn(shared: Shared, text: string): void {
  if (shared.emitted.has(text)) return;
  shared.emitted.add(text);
  shared.warnings.push(text);
}

function read(shared: Shared, canonical: string): Loaded {
  const cached = shared.reads.get(canonical);
  if (cached) return cached;
  if (cached === null) throw new Error(`Could not read ${canonical}`);
  try {
    const loaded = readContext(canonical);
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
    readonly shared: Shared,
    readonly external: boolean,
  ) {}
  line(value: string): void {
    if (this.external) this.#pending += `${value}\n`;
    else {
      this.#text += append(value, this.shared.budget, this.shared.warnings);
      this.#text += append("\n", this.shared.budget, this.shared.warnings);
    }
  }
  /** Add already-budgeted text from an import, with the line break that ended its line. */
  insert(value: string, lineBreak: boolean): void {
    this.#flush();
    this.#text += value;
    if (lineBreak) this.#text += append("\n", this.shared.budget, this.shared.warnings);
  }
  finish(): string {
    this.#flush();
    return this.#text;
  }
  #flush(): void {
    if (!this.#pending) return;
    // Whole runs at once, so a multi-line private key is recognized and removed.
    const redacted = sanitizeSessionText(this.#pending, { value: 0 });
    this.#text += append(redacted, this.shared.budget, this.shared.warnings);
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
      `Instruction file exceeds ${FILE_CHARS} characters and was truncated for preview: ${file}`,
    );
  const output = new Output(shared, external);
  const here: Position = { canonical, depth, stack, external };
  let fence: Fence | null = null;
  stack.add(canonical);
  try {
    for (const line of lines(loaded.content)) {
      if (!shared.budget.remaining) {
        budgetWarning(shared.warnings);
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

function importPath(containing: string, written: string, environment: NodeJS.ProcessEnv) {
  if (written.length > MAX_TOKEN_CHARS) return null;
  const home = written.startsWith("~/") || written.startsWith("~\\");
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
  const resolved = importPath(holder, token.written, shared.environment);
  if (resolved === null || !isFile(resolved)) {
    // Only a line that is nothing but an import is reported: elsewhere an @ may well be an
    // email address or a package name, so a missing file is not worth a warning.
    if (standalone)
      warn(
        shared,
        `Imported file is missing: ${resolved ?? `${token.written.slice(0, 200)}...`} (source: ${holder})`,
      );
    return null;
  }
  if (source.imports >= MAX_IMPORTS) {
    warn(
      shared,
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
    warn(shared, `Instruction import could not be read: ${resolved} (source: ${holder})`);
    return null;
  }
  if (here.stack.has(target)) {
    warn(
      shared,
      `Instruction import skipped (circular reference): ${resolved} (source: ${holder})`,
    );
    return null;
  }
  if (here.depth + 1 > MAX_HOPS) {
    warn(
      shared,
      `Instruction import skipped (deeper than ${MAX_HOPS} hops): ${resolved} (source: ${holder})`,
    );
    return null;
  }
  // Two boundaries: outside the project decides filtering and redaction, outside the working
  // directory only decides the note, because that is what Claude Code asks about.
  const outsideProject = here.external || !within(target, shared.root);
  const note = `${CONTEXT_NOTE_PREFIX}External import (outside the working directory): ${token.written} (source: ${holder}).`;
  if (outsideProject) {
    if (isSensitiveExternalPath(resolved, target)) {
      warn(shared, `Instruction import skipped (sensitive path): ${resolved} (source: ${holder})`);
      return null;
    }
    if (!shared.externalBodies) {
      warn(shared, `${note} ${OMITTED}`);
      return null;
    }
  }
  if (!within(target, shared.cwd))
    warn(shared, `${note} ${source.kind === "agents" ? APPROVED_EARLIER : ASKS_FIRST}`);
  try {
    return expand(source, resolved, target, here.depth + 1, here.stack, outsideProject);
  } catch {
    warn(shared, `Instruction import could not be read: ${resolved} (source: ${holder})`);
    return null;
  }
}

/** The project instruction sections Claude Code would load for this working directory. */
export async function claudeSections(options: ClaudeContextOptions): Promise<Section[]> {
  const { root, dirs, budget, warnings } = options;
  const shared: Shared = {
    root,
    cwd: options.cwd,
    environment: options.environment,
    budget,
    warnings,
    externalBodies: options.externalBodies,
    emitted: new Set(warnings),
    reads: new Map(),
  };
  const claudeFiles = dirs.flatMap((dir) =>
    ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]
      .map((name) => path.join(dir, name))
      .filter(isFile),
  );
  const tops: { file: string; kind: Kind }[] = claudeFiles.map((file) => ({
    file,
    kind: "claude",
  }));
  // Only an existing CLAUDE.md-style file stops the fallback. The user-level CLAUDE.md, managed
  // policy files and rules do not count, and neither does a file that is later refused.
  const fallback = claudeFiles.length === 0;
  const agentsFiles: string[] = [];
  if (fallback) {
    const seen = new Set<string>();
    for (const dir of dirs)
      for (const name of ["AGENTS.md", ".claude/AGENTS.md"]) {
        const file = path.join(dir, name);
        if (!isFile(file)) continue;
        let key = file;
        try {
          key = pathIdentity(canonicalize(file));
        } catch {}
        if (seen.has(key)) continue;
        seen.add(key);
        agentsFiles.push(file);
      }
    for (const file of agentsFiles) tops.push({ file, kind: "agents" });
  }
  for (const file of sortedFiles(path.join(root, ".claude/rules"), ".md"))
    tops.push({ file, kind: "claude" });
  const sections: Section[] = [];
  for (const { file, kind } of tops) {
    if (!budget.remaining) {
      budgetWarning(warnings);
      break;
    }
    let canonical: string;
    try {
      canonical = canonicalize(file);
    } catch {
      warn(shared, `Could not read ${file}`);
      continue;
    }
    // A top-level source that resolves outside the project (a link to a file elsewhere) is
    // refused, not read: it is the body of the preview and would bypass the filter, redaction and
    // MCP omission that apply to imports outside the project. That keeps today's behavior.
    if (!within(canonical, root)) {
      warn(shared, `Instruction source skipped (outside the project): ${file}`);
      continue;
    }
    const source: Source = { shared, kind, top: canonical, imports: 0, limited: false };
    try {
      sections.push({
        source: file,
        scope: path.relative(root, path.dirname(file)),
        content: expand(source, file, canonical, 0, new Set(), false),
        precedence: sections.length,
      });
    } catch {
      warn(shared, `Could not read ${file}`);
    }
  }
  if (fallback) {
    if (agentsFiles.length) {
      let version: string | null = null;
      try {
        version = await options.version();
      } catch {
        // A version that cannot be read is an unknown version, never a failed preview.
      }
      if (version === null) warn(shared, AGENTS_VERSION_UNKNOWN);
      else if (!supportsClaudeVersion(version, AGENTS_FROM))
        warn(shared, agentsTooOld(version.split(" ")[0]!));
    }
    warn(shared, ABOVE_ROOT_NOTE);
  }
  return sections;
}
