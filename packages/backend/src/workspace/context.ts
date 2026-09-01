import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { backendError } from "../contracts.js";
import type { AgentKind, Manifest } from "../domain/types.js";

const MAX_FILE_CHARS = 128 * 1024;
const MAX_TOTAL_CHARS = 512 * 1024;
const DEEPSEEK_MAX_CONTEXT_BYTES = 64 * 1024;
const DEEPSEEK_MAX_SOURCE_BYTES = 1024 * 1024;
type ContextSection = {
  source: string;
  scope: string;
  content: string;
  precedence: number;
};

/** Resolve the same native instruction chain that the desktop agents use. */
export async function resolveWorkspaceContext(
  project: string,
  cwd: string,
  agent: AgentKind,
  manifest?: Manifest,
  approvedMemories: string[] = [],
) {
  const root = await canonicalPath(project);
  const cwdCandidate = cwd
    ? path.isAbsolute(cwd)
      ? cwd
      : path.join(path.resolve(project), cwd)
    : project;
  const workingDirectory = await canonicalPath(cwdCandidate);
  if (!isInside(workingDirectory, root))
    throw backendError("VALIDATION", "Working directory must be inside the project");
  const metadata = await lstat(workingDirectory).catch(() => undefined);
  if (!metadata?.isDirectory())
    throw backendError("NOT_FOUND", `Working directory does not exist: ${workingDirectory}`);

  const warnings: string[] = [];
  const contextRoot =
    agent === "deepseek-harness" ? await deepseekProjectRoot(root, workingDirectory) : root;
  const sections =
    agent === "deepseek-harness"
      ? await deepseekSections(contextRoot, workingDirectory, warnings)
      : await nativeSections(root, workingDirectory, agent, warnings);

  const override = manifest?.instructions.platform_overrides?.[agent]?.trim();
  if (override && !sections.some((section) => section.content.includes(override))) {
    if (sections.length)
      warnings.push(
        "The platform override is applied after native project instructions; check for semantic conflicts",
      );
    sections.push({
      source: path.join(root, ".agentkib", "manifest.yaml"),
      scope: "platform-override",
      content: override,
      precedence: sections.length,
    });
  }
  if (!sections.length) warnings.push("No project instruction file was found for this Agent");

  const visibleSkills =
    agent === "deepseek-harness"
      ? await deepseekSkills(contextRoot)
      : (manifest?.skills ?? [])
          .filter((skill) => !skill.targets.length || skill.targets.includes(agent))
          .map((skill) => skill.name);
  const visibleConnections =
    agent === "deepseek-harness"
      ? []
      : (manifest?.connections ?? [])
          .filter((connection) => !connection.targets.length || connection.targets.includes(agent))
          .map((connection) => connection.name);
  return {
    agent,
    project: root,
    cwd: workingDirectory,
    sections,
    visible_skills: visibleSkills,
    visible_connections: visibleConnections,
    approved_memories: approvedMemories,
    warnings,
  };
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return realpath(resolved).catch(() => resolved);
}

async function nativeSections(
  root: string,
  cwd: string,
  agent: AgentKind,
  warnings: string[],
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];
  let remaining = MAX_TOTAL_CHARS;
  const sources = await nativeSources(root, cwd, agent);
  for (const source of sources) {
    if (remaining <= 0) {
      warnings.push(
        `Resolved project instructions exceed ${MAX_TOTAL_CHARS} characters and were truncated for preview`,
      );
      break;
    }
    const visited = new Set<string>();
    try {
      const content = await loadWithImports(
        source,
        root,
        visited,
        0,
        () => remaining,
        (value) => {
          remaining = value;
        },
        warnings,
      );
      if (!content.trim()) continue;
      sections.push({
        source,
        scope: path.relative(root, path.dirname(source)) || "shared",
        content,
        precedence: sections.length,
      });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not read ${source}`);
    }
  }
  return sections;
}

async function deepseekProjectRoot(workspace: string, cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    if (await isDirectory(path.join(current, ".git"))) return current;
    if (current === workspace) return cwd;
    const parent = path.dirname(current);
    if (parent === current || !isInside(parent, workspace)) return cwd;
    current = parent;
  }
}

async function deepseekSections(
  root: string,
  cwd: string,
  warnings: string[],
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];
  const state = { value: DEEPSEEK_MAX_CONTEXT_BYTES };
  const home = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : process.env.HOME
      ? path.join(process.env.HOME, ".dsh")
      : process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, ".dsh")
        : undefined;
  if (home) {
    await pushDeepSeekFile(sections, path.join(home, "AGENTS.md"), "agent-home", state, warnings);
    if (await hasDeepSeekCustomRules(home))
      warnings.push(
        "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules",
      );
  }
  for (const dir of directoryChain(root, cwd)) {
    const seen = new Set<string>();
    for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"]) {
      const file = path.join(dir, name);
      const content = await readDeepSeekFile(file, warnings);
      if (content === undefined) continue;
      const normalized = content.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (
        name === "CLAUDE.md" &&
        content.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md")
      )
        warnings.push(
          "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
        );
      pushDeepSeekContent(
        sections,
        file,
        path.relative(root, dir) || ".",
        content,
        state,
        warnings,
      );
    }
  }
  return sections;
}

async function pushDeepSeekFile(
  sections: ContextSection[],
  file: string,
  scope: string,
  state: { value: number },
  warnings: string[],
): Promise<void> {
  const content = await readDeepSeekFile(file, warnings);
  if (content !== undefined) pushDeepSeekContent(sections, file, scope, content, state, warnings);
}

async function readDeepSeekFile(file: string, warnings: string[]): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  if (info.size > DEEPSEEK_MAX_SOURCE_BYTES) {
    warnings.push(`DeepSeek Harness instruction file exceeds 1 MiB and was skipped: ${file}`);
    return undefined;
  }
  return readFile(file, "utf8").catch(() => {
    warnings.push(`Could not read ${file}`);
    return undefined;
  });
}

function pushDeepSeekContent(
  sections: ContextSection[],
  source: string,
  scope: string,
  content: string,
  state: { value: number },
  warnings: string[],
): void {
  if (state.value <= 0) {
    warnings.push("DeepSeek Harness instruction budget of 64 KiB was exhausted");
    return;
  }
  const bytes = Buffer.byteLength(content);
  const take = Math.min(bytes, state.value);
  let truncated = Buffer.from(content, "utf8").subarray(0, take).toString("utf8");
  if (take < bytes) {
    warnings.push(`DeepSeek Harness instruction budget of 64 KiB truncated ${source}`);
    truncated = truncated.replace(/\ufffd$/, "");
  }
  sections.push({ source, scope, content: truncated, precedence: sections.length });
  state.value -= Buffer.byteLength(truncated);
}

async function hasDeepSeekCustomRules(home: string): Promise<boolean> {
  const candidates = [path.join(home, "cordis.patch.yml")];
  const profiles = path.join(home, "profiles");
  for (const entry of await readdir(profiles, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory()) candidates.push(path.join(profiles, entry.name, "cordis.patch.yml"));
  for (const file of candidates) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (content.includes("agent-instructions") || content.includes("skill-filesystem")) return true;
  }
  return false;
}

async function deepseekSkills(root: string): Promise<string[]> {
  const roots = [path.join(root, ".dsh", "skills"), path.join(root, ".agents", "skills")];
  const home = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : process.env.HOME
      ? path.join(process.env.HOME, ".dsh")
      : undefined;
  if (home) roots.push(path.join(home, "skills"));
  if (process.env.HOME) roots.push(path.join(process.env.HOME, ".agents", "skills"));
  const names = new Set<string>();
  for (const skillRoot of roots) {
    for (const entry of await readdir(skillRoot, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(skillRoot, entry.name);
      if (entry.isDirectory() && (await isFile(path.join(candidate, "SKILL.md"))))
        names.add(entry.name);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md")
        names.add(path.basename(entry.name, ".md"));
    }
  }
  return [...names].sort();
}

async function isDirectory(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isDirectory() ?? false;
}

async function nativeSources(root: string, cwd: string, agent: AgentKind): Promise<string[]> {
  const dirs = directoryChain(root, cwd);
  const output: string[] = [];
  const addFirst = async (dir: string, names: string[]) => {
    for (const name of names) {
      const file = path.join(dir, name);
      if (await isFile(file)) {
        output.push(file);
        return;
      }
    }
  };
  if (agent === "codex") {
    for (const dir of dirs) await addFirst(dir, ["AGENTS.override.md", "AGENTS.md"]);
  } else if (agent === "claude-code") {
    for (const dir of dirs) {
      for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"])
        if (await isFile(path.join(dir, name))) output.push(path.join(dir, name));
    }
    output.push(...(await markdownFiles(path.join(root, ".claude", "rules"))));
  } else if (agent === "cursor") {
    for (const dir of dirs) {
      const agents = path.join(dir, "AGENTS.md");
      if (await isFile(agents)) output.push(agents);
      for (const rule of await markdownFiles(path.join(dir, ".cursor", "rules"))) {
        if (
          (await readFile(rule, "utf8").catch(() => ""))
            .split(/\r?\n/)
            .slice(0, 32)
            .some((line) => /^alwaysApply\s*:\s*true\s*$/i.test(line.trim()))
        )
          output.push(rule);
      }
    }
  } else if (agent === "open-claw") {
    for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md"])
      if (await isFile(path.join(root, name))) output.push(path.join(root, name));
    for (const dir of dirs.slice(1)) await addFirst(dir, ["AGENTS.md"]);
  } else if (agent === "hermes") {
    for (const dir of dirs)
      await addFirst(dir, [".hermes.md", "HERMES.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"]);
  } else {
    for (const dir of dirs)
      await addFirst(dir, ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"]);
  }
  return [...new Set(output)];
}

function directoryChain(root: string, cwd: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === root) return dirs;
    const parent = path.dirname(current);
    if (parent === current || !isInside(parent, root)) return [root];
    current = parent;
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.mdc?$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function isFile(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isFile() ?? false;
}

async function loadWithImports(
  file: string,
  root: string,
  visited: Set<string>,
  depth: number,
  getRemaining: () => number,
  setRemaining: (value: number) => void,
  warnings: string[],
): Promise<string> {
  if (depth > 5) throw new Error(`Instruction import depth exceeds 5: ${file}`);
  const canonical = await realpath(file).catch(() => path.resolve(file));
  if (!isInside(canonical, root))
    throw new Error(`Refusing to import instructions outside the project: ${file}`);
  if (visited.has(canonical)) throw new Error(`Circular instruction import detected: ${file}`);
  visited.add(canonical);
  try {
    const raw = await readFile(canonical, "utf8");
    const truncated = [...raw].slice(0, MAX_FILE_CHARS).join("");
    if ([...raw].length > MAX_FILE_CHARS)
      warnings.push(
        `Instruction file exceeds ${MAX_FILE_CHARS} characters and was truncated for preview: ${file}`,
      );
    let output = "";
    for (const line of truncated.split(/\r?\n/)) {
      if (getRemaining() <= 0) break;
      const imported =
        line.trim().startsWith("@") && !line.trim().slice(1).includes(" ")
          ? line.trim().slice(1)
          : undefined;
      if (imported) {
        const importFile = path.resolve(path.dirname(canonical), imported);
        if (await isFile(importFile)) {
          output += await loadWithImports(
            importFile,
            root,
            visited,
            depth + 1,
            getRemaining,
            setRemaining,
            warnings,
          );
          output += "\n";
          continue;
        }
        warnings.push(`Imported file is missing: ${importFile} (source: ${canonical})`);
      }
      const chars = [...line, "\n"];
      const chunk = chars.slice(0, getRemaining()).join("");
      output += chunk;
      setRemaining(getRemaining() - [...chunk].length);
    }
    return output;
  } finally {
    visited.delete(canonical);
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
