import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { backendError } from "../contracts.js";
import type { AgentKind, Manifest } from "../domain/types.js";

const MAX_FILE_CHARS = 128 * 1024;
const MAX_TOTAL_CHARS = 512 * 1024;
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
  const root = path.resolve(project);
  const workingDirectory = path.resolve(cwd || project);
  if (!isInside(workingDirectory, root))
    throw backendError("VALIDATION", "Working directory must be inside the project");
  const metadata = await lstat(workingDirectory).catch(() => undefined);
  if (!metadata?.isDirectory())
    throw backendError("NOT_FOUND", `Working directory does not exist: ${workingDirectory}`);

  const warnings: string[] = [];
  const sections: ContextSection[] = [];
  let remaining = MAX_TOTAL_CHARS;
  const sources = await nativeSources(root, workingDirectory, agent);
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

  const visibleSkills = (manifest?.skills ?? [])
    .filter((skill) => !skill.targets.length || skill.targets.includes(agent))
    .map((skill) => skill.name);
  const visibleConnections = (manifest?.connections ?? [])
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
  const canonical = path.resolve(file);
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
